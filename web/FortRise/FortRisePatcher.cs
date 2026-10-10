using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace TowerFallBrowser;

// Produces TowerFall.Patch.dll the way the FortRise launcher does (FortLauncher/Program.cs Launch):
// clear the 32-bit flags on TowerFall.exe, then the steps of FortRise's FortRiseHandler.TryPatch,
// which MonoMod TowerFall.FortRise.mm.dll into it. The result is cached next to the patch module, keyed
// on the exact inputs, so it only reruns when the game or FortRise changes.
//
// Shared by the browser host and tools/FortRisePatch (the same code on desktop .NET, for testing).
public static class FortRisePatcher
{
	public const string PatchModule = "TowerFall.FortRise.mm.dll";
	public const string PatchFile = "TowerFall.Patch.dll";

	// Bump when BrowserFixups changes, so cached patches are redone.
	private const int FixupsVersion = 6;

	// fortriseDir holds TowerFall.FortRise.mm.dll plus the assemblies TowerFall.exe references
	// (FNA.dll, Steamworks.NET.dll); MonoMod resolves dependencies from the working directory.
	// progress, if given, is told how far patching is (0 to 1) as it goes.
	public static string EnsurePatched(string exePath, string fortriseDir, string fortriseVersion, ILoggerFactory loggers, Action<double> progress = null)
	{
		ILogger log = loggers.CreateLogger("FortRise");
		string patchFile = Path.Combine(fortriseDir, PatchFile);
		string stampFile = patchFile + ".inputs";
		string stamp = $"{fortriseVersion} fixups{FixupsVersion} {Sha256(exePath)} {Sha256(Path.Combine(fortriseDir, PatchModule))}";
		if (File.Exists(patchFile) && File.Exists(stampFile) && File.ReadAllText(stampFile) == stamp)
		{
			log.LogInformation("TowerFall.Patch.dll is up to date, skipping patch.");
			return patchFile;
		}

		log.LogInformation("Patching TowerFall.exe (once per FortRise version)...");
		using var exe = new MemoryStream(File.ReadAllBytes(exePath));
		string previousDir = Directory.GetCurrentDirectory();
		Directory.SetCurrentDirectory(fortriseDir);
		try
		{
			var started = System.Diagnostics.Stopwatch.StartNew();
			TryPatch(exe, patchFile, log, progress ?? (_ => { }));
			log.LogInformation("Patched TowerFall.exe in {Seconds:0.0}s.", started.Elapsed.TotalSeconds);
		}
		finally
		{
			Directory.SetCurrentDirectory(previousDir);
		}
		File.WriteAllText(stampFile, stamp);
		return patchFile;
	}

	// FortLauncher.FortRiseHandler.TryPatch, step for step, with changes that save time (in the
	// browser, about half of it): an assembly resolver that remembers failed lookups (see
	// CachingAssemblyResolver); the 32-bit flags cleared on the module MonoMod reads, rather than by
	// writing and reading TowerFall.exe once more beforehand; the browser fixups applied before
	// MonoMod writes the module, rather than reading and writing it again afterwards; no symbols.
	//
	// progress gets each step's share of the time it takes (measured in Chrome), and per method in
	// PatchRefs, about half of it.
	private static void TryPatch(Stream exe, string patchFile, ILogger log, Action<double> progress)
	{
		Environment.SetEnvironmentVariable("MONOMOD_DEPENDENCY_MISSING_THROW", "0");
		using var modder = new FortLauncher.FortRiseMonoModder
		{
			Input = exe,
			OutputPath = patchFile,
			LogVerboseEnabled = false,
			AssemblyResolver = new CachingAssemblyResolver(),
			WriterParameters = new WriterParameters { WriteSymbols = false },
		};
		progress(0);
		modder.Read();
		progress(0.03);
		// What FortLauncher's Remove32BitFlagsPatcher does.
		modder.Module.Attributes &= ~(ModuleAttributes.Required32Bit | ModuleAttributes.Preferred32Bit);
		modder.Log("[Main] Scanning for TowerFall.FortRise.mm.dll.");
		modder.ReadMod(Path.GetFullPath(PatchModule));
		modder.MapDependencies();
		progress(0.25);
		// AutoPatch's PatchRefs pass hands MethodRewriter each method with a body, after the Patch
		// pass; the post-processors run after it.
		int methods = 0, total = 0;
		modder.MethodRewriter += (m, method) =>
		{
			if (total == 0) total = Math.Max(1, m.Module.GetTypes().Sum(t => t.Methods.Count(x => x.HasBody)));
			progress(0.36 + 0.48 * Math.Min(1, ++methods / (double)total));
		};
		modder.PostProcessors = (MonoMod.PostProcessor)(_ => progress(0.84)) + modder.PostProcessors;
		modder.PostProcessors += _ => progress(0.95);
		modder.Log("[Main] modder.AutoPatch()");
		modder.AutoPatch();
		BrowserFixups(modder.Module, log);
		modder.Write();
		progress(1);
		modder.Log("[Main] Done.");
	}

	// Cecil's DefaultAssemblyResolver caches the assemblies it finds but not the ones it doesn't:
	// every reference into a missing assembly searches the directories again and throws. MonoMod's
	// PatchRefs pass resolves each type reference in TowerFall.exe, so on desktop .NET half of its
	// time went to that, and far more in the browser, where file probes and exceptions are slow.
	private sealed class CachingAssemblyResolver : DefaultAssemblyResolver
	{
		private readonly HashSet<string> missing = new();

		public override AssemblyDefinition Resolve(AssemblyNameReference name)
		{
			if (missing.Contains(name.FullName)) return null;
			try
			{
				return base.Resolve(name);
			}
			catch (AssemblyResolutionException)
			{
				missing.Add(name.FullName);
				return null;
			}
		}
	}

	// Browser-specific changes to the patched game, applied after FortRise's MonoMod pass: calls to
	// APIs that don't fit the browser are sent to TowerFallBrowser.BrowserShims instead.
	private static void BrowserFixups(ModuleDefinition module, ILogger log)
	{
		var host = new AssemblyNameReference("TowerFallBrowser", new Version(1, 0, 0, 0));
		module.AssemblyReferences.Add(host);
		var shims = new TypeReference("TowerFallBrowser", "BrowserShims", module, host);
		var platform = new MethodReference("Platform", module.TypeSystem.String, shims);
		var location = new MethodReference("AssemblyLocation", module.TypeSystem.String, shims);
		location.Parameters.Add(new ParameterDefinition(module.ImportReference(typeof(System.Reflection.Assembly))));
		var loadMods = new MethodReference("LoadMods", module.TypeSystem.Void, shims);
		loadMods.Parameters.Add(new ParameterDefinition(module.TypeSystem.Object));
		loadMods.Parameters.Add(new ParameterDefinition(module.ImportReference(typeof(System.Collections.IList))));

		int platforms = 0, locations = 0, modLoads = 0;
		foreach (TypeDefinition type in module.GetTypes())
		{
			foreach (MethodDefinition method in type.Methods)
			{
				if (!method.HasBody) continue;
				foreach (Instruction instr in method.Body.Instructions)
				{
					if ((instr.OpCode != OpCodes.Call && instr.OpCode != OpCodes.Callvirt) || instr.Operand is not MethodReference called)
					{
						continue;
					}
					// The game picks save and content paths by asking SDL for the OS name; FortRise
					// already rewrote the game's SDL2 calls to SDL3.
					if (called.Name == "SDL_GetPlatform" && called.DeclaringType.FullName is "SDL3.SDL" or "SDL2.SDL")
					{
						instr.OpCode = OpCodes.Call;
						instr.Operand = platform;
						platforms++;
					}
					// FortRise's Relinker reads loaded assemblies' files via Assembly.Location.
					else if (called.Name == "get_Location" && called.DeclaringType.FullName == "System.Reflection.Assembly")
					{
						instr.OpCode = OpCodes.Call;
						instr.Operand = location;
						locations++;
					}
					// FortRise's mod loader can load a mod twice, depending on the mods' order (see
					// BrowserShims.LoadMods).
					else if (called.Name == "LoadMods" && called.DeclaringType.FullName == "FortRise.ModuleManager" && method.Name != "LoadMods")
					{
						instr.OpCode = OpCodes.Call;
						instr.Operand = loadMods;
						modLoads++;
					}
				}
			}
		}
		// FortRise's own updater would show "update available" for FortRise and download newer mod
		// versions behind the page's back; the site pins both (mods/catalog.json), so turn it off.
		int updaters = 0;
		TypeDefinition tfGame = module.GetType("TowerFall.TFGame");
		var completed = module.ImportReference(typeof(System.Threading.Tasks.Task).GetProperty("CompletedTask").GetMethod);
		foreach (MethodDefinition method in tfGame?.Methods.Where(m => m.Name is "CheckUpdate" or "CheckModUpdate" && m.HasBody && m.Parameters.Count == 0) ?? Enumerable.Empty<MethodDefinition>())
		{
			method.Body.Instructions.Clear();
			method.Body.ExceptionHandlers.Clear();
			method.Body.Variables.Clear();
			ILProcessor il = method.Body.GetILProcessor();
			il.Emit(OpCodes.Call, completed);
			il.Emit(OpCodes.Ret);
			updaters++;
		}

		// Mods' native libraries can't be loaded from files in the browser; the ones mods need (TF.EX's
		// ggrs_ffi) are linked into the app, which the runtime finds when the load context declines.
		int natives = 0;
		TypeDefinition modContext = module.GetType("FortRise.ModAssemblyLoadContext");
		foreach (MethodDefinition method in modContext?.Methods.Where(m => m.Name == "LoadUnmanagedDll" && m.HasBody) ?? Enumerable.Empty<MethodDefinition>())
		{
			method.Body.Instructions.Clear();
			method.Body.ExceptionHandlers.Clear();
			method.Body.Variables.Clear();
			ILProcessor il = method.Body.GetILProcessor();
			il.Emit(OpCodes.Ldc_I4_0);
			il.Emit(OpCodes.Conv_I);
			il.Emit(OpCodes.Ret);
			natives++;
		}

		log.LogInformation("Browser fixups: {Platforms} platform checks and {Locations} assembly locations answered by the host, {ModLoads} mod loads ordered by it, {Updaters} update checks disabled, {Natives} native loaders deferred to the app.", platforms, locations, modLoads, updaters, natives);
	}

	private static string Sha256(string path)
	{
		using FileStream f = File.OpenRead(path);
		return Convert.ToHexString(SHA256.HashData(f));
	}
}

// Minimal console logging (Microsoft.Extensions.Logging's console logger uses a background
// queue thread and ANSI colors; plain Console.WriteLine is what we want in the browser).
public sealed class PlainConsoleLoggerProvider : ILoggerProvider
{
	public ILogger CreateLogger(string categoryName) => new Logger(categoryName);

	public void Dispose()
	{
	}

	private sealed class Logger(string category) : ILogger
	{
		public IDisposable BeginScope<TState>(TState state) where TState : notnull => null;

		// TOWERFALL_LOG=debug (the page's ?debug) includes debug output, e.g. FortRise's list of
		// Harmony patches and why mods were skipped.
		private static readonly LogLevel Minimum =
			Environment.GetEnvironmentVariable("TOWERFALL_LOG") == "debug" ? LogLevel.Debug : LogLevel.Information;

		public bool IsEnabled(LogLevel logLevel) => logLevel >= Minimum;

		public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception exception, Func<TState, Exception, string> formatter)
		{
			if (!IsEnabled(logLevel)) return;
			string line = $"[{logLevel}][{category}] {formatter(state, exception)}";
			if (exception != null) line += Environment.NewLine + exception;
			if (logLevel >= LogLevel.Warning) Console.Error.WriteLine(line);
			else Console.WriteLine(line);
		}
	}
}
