using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Microsoft.Extensions.Logging;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace TowerFallBrowser;

// Faster state saving for TF.State (TF.EX's rollback state), which saves the whole level 240 times
// a second. Its GetAll<T>() finds a level's entities of a type with a LINQ chain over every entity
// in every layer, and one save asks for about 40 types: slow in the browser's interpreter. Here,
// GetAll<T> is rewritten (in the installed DLL) to call GetAll below, which scans the level once
// per save and filters that snapshot with a plain loop. Same entities, same order, so the saved
// state is byte-for-byte what TF.State would produce (other players and replays rely on that).
public static class StateSpeedups
{
	private const string ExtensionsDll = "TF.State.TowerFallExtensions.dll";
	private const string LevelExtensions = "TF.State.TowerFallExtensions.LevelExtensions";

	// --- Install time ----------------------------------------------------------------------

	// Rewrites the installed TF.State's GetAll<T> to call ours, unless it already does. (FortRise
	// relinks an assembly again when its checksum changes, so the cache picks this up.)
	public static void Install(string modsDir, ILogger log)
	{
		string path = Directory.Exists(modsDir)
			? Directory.EnumerateFiles(modsDir, ExtensionsDll, SearchOption.AllDirectories).FirstOrDefault(p => !p.Contains("_RelinkerCache"))
			: null;
		if (path == null) return;
		using var module = ModuleDefinition.ReadModule(new MemoryStream(File.ReadAllBytes(path)));
		MethodDefinition getAll = module.GetType(LevelExtensions)?.Methods
			.FirstOrDefault(m => m.Name == "GetAll" && m.HasGenericParameters && m.Parameters.Count == 1);
		if (getAll == null)
		{
			log.LogWarning("TF.State's GetAll<T> wasn't found; state saving stays unoptimized.");
			return;
		}
		if (getAll.Body.Instructions.Any(i => i.Operand is MethodReference r && r.DeclaringType.FullName == "TowerFallBrowser.StateSpeedups"))
		{
			return;
		}

		var host = new AssemblyNameReference("TowerFallBrowser", new Version(1, 0, 0, 0));
		module.AssemblyReferences.Add(host);
		var helper = new MethodReference(nameof(GetAll), module.TypeSystem.Void, new TypeReference("TowerFallBrowser", nameof(StateSpeedups), module, host));
		var t = new GenericParameter("T", helper);
		helper.GenericParameters.Add(t);
		// IEnumerable<T>, from the original's own return type (so it binds to the same assembly).
		var returnType = new GenericInstanceType(((GenericInstanceType)getAll.ReturnType).ElementType);
		returnType.GenericArguments.Add(t);
		helper.ReturnType = returnType;
		helper.Parameters.Add(new ParameterDefinition(module.TypeSystem.Object));
		var call = new GenericInstanceMethod(helper);
		call.GenericArguments.Add(getAll.GenericParameters[0]);

		getAll.Body.Instructions.Clear();
		getAll.Body.ExceptionHandlers.Clear();
		getAll.Body.Variables.Clear();
		ILProcessor il = getAll.Body.GetILProcessor();
		il.Emit(OpCodes.Ldarg_0);
		il.Emit(OpCodes.Call, call);
		il.Emit(OpCodes.Ret);
		module.Write(path);
		File.Delete(Path.ChangeExtension(path, ".pdb")); // no longer matches
		log.LogInformation("Optimized TF.State's entity lookups for the browser.");
	}

	// --- Run time --------------------------------------------------------------------------

	private static PropertyInfo layersProperty;
	private static PropertyInfo entitiesProperty;
	private static object[] snapshot = new object[1024];
	private static int snapshotCount;
	private static object snapshotLevel;
	private static bool capturing;

	// Saves are bracketed (TfStateApi.CaptureGameState), so the snapshot never outlives the save
	// it was taken for; elsewhere (loading states, where entities come and go) every call scans.
	public static void Patch(Harmony harmony)
	{
		Type api = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.State.Core.Api.TfStateApi")).FirstOrDefault(t => t != null);
		MethodInfo capture = api?.GetMethod("CaptureGameState", BindingFlags.Public | BindingFlags.Instance);
		if (capture == null) return;
		const BindingFlags flags = BindingFlags.NonPublic | BindingFlags.Static;
		harmony.Patch(capture,
			prefix: new HarmonyMethod(typeof(StateSpeedups).GetMethod(nameof(BeginCapture), flags)),
			finalizer: new HarmonyMethod(typeof(StateSpeedups).GetMethod(nameof(EndCapture), flags)));
	}

	private static void BeginCapture()
	{
		capturing = true;
		snapshotLevel = null;
	}

	private static Exception EndCapture(Exception __exception)
	{
		capturing = false;
		snapshotLevel = null;
		Array.Clear(snapshot, 0, snapshotCount); // don't keep entities alive
		snapshotCount = 0;
		return __exception;
	}

	// LevelExtensions.GetAll<T>(level): level.Layers.SelectMany(l => l.Value.Entities).Where(e => e is T).
	// Time spent in GetAll and its calls, reported by the profiler.
	public static long GetAllTicks;
	public static int GetAllCalls;

	public static IEnumerable<T> GetAll<T>(object level)
	{
		long started = Profiler.Enabled ? System.Diagnostics.Stopwatch.GetTimestamp() : 0;
		try
		{
			return GetAllCore<T>(level);
		}
		finally
		{
			if (started != 0)
			{
				GetAllTicks += System.Diagnostics.Stopwatch.GetTimestamp() - started;
				GetAllCalls++;
			}
		}
	}

	private static IEnumerable<T> GetAllCore<T>(object level)
	{
		if (!capturing || snapshotLevel != level)
		{
			TakeSnapshot(level);
			snapshotLevel = capturing ? level : null;
		}
		var result = new List<T>();
		object[] all = snapshot;
		for (int i = 0, n = snapshotCount; i < n; i++)
		{
			if (all[i] is T entity) result.Add(entity);
		}
		if (!capturing)
		{
			Array.Clear(snapshot, 0, snapshotCount);
			snapshotCount = 0;
		}
		return result;
	}

	private static void TakeSnapshot(object level)
	{
		layersProperty ??= level.GetType().GetProperty("Layers");
		int n = 0;
		foreach (DictionaryEntry layer in (IDictionary)layersProperty.GetValue(level))
		{
			entitiesProperty ??= layer.Value.GetType().GetProperty("Entities");
			var entities = (IList)entitiesProperty.GetValue(layer.Value);
			int count = entities.Count;
			if (n + count > snapshot.Length) Array.Resize(ref snapshot, Math.Max(snapshot.Length * 2, n + count));
			for (int i = 0; i < count; i++) snapshot[n++] = entities[i];
		}
		if (n < snapshotCount) Array.Clear(snapshot, n, snapshotCount - n);
		snapshotCount = n;
	}
}
