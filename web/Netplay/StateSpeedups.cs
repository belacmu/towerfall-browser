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

// Faster state saving and loading for TF.State (TF.EX's rollback state), which saves the whole level
// 240 times a second and loads it on every rollback. Both are slow in the browser's interpreter:
// - GetAll<T>() finds a level's entities of a type with a LINQ chain over every entity in every layer,
//   and one save asks for about 40 types. It's rewritten (in the installed DLL) to call GetAll below,
//   which scans the level once per save and filters that snapshot with a plain loop.
// - DeleteAll<T>() and Delete<T>(), which a load calls for about 45 types (most of which a level never
//   has), filter every layer and its pending adds the same way. They now first ask AnyEntity<T>, which
//   remembers per list whether it holds a T until the list changes, and return straight away if
//   nothing matches (when something does, their own code runs as before).
// - GetEntityByDepth(depth), which a rollback load calls for every arrow, corpse, bat and prism, copied the
//   gameplay layer's entity list and read each entity's actualDepth through DynamicData (a boxed double
//   each). It now first asks EntityByDepth below: the same first match, from the list itself, with the
//   field read directly. CompareDepth, the comparison a load sorts the gameplay and HUD layers with (two
//   boxed reads per comparison), reads the fields directly the same way. ?env=TOWERFALL_ENTITYBYDEPTH=0
//   keeps the originals of both.
// Same entities, same order, so the state is byte-for-byte what TF.State would produce (other players
// and replays rely on that).
public static class StateSpeedups
{
	private const string ExtensionsDll = "TF.State.TowerFallExtensions.dll";
	private const string LevelExtensions = "TF.State.TowerFallExtensions.LevelExtensions";

	// The main site and every preview share the page's storage (OPFS), so the TF.State a device has
	// installed may have been adapted by another build. Each adaptation is stamped with this; bump it
	// whenever what Install does changes. A copy adapted by anything else is extracted again first.
	private const string AdaptationVersion = "state-load-3";
	private const string StampResource = "TowerFallBrowser.Adaptation";

	// --- Install time ----------------------------------------------------------------------

	// Rewrites the installed TF.State's GetAll<T> to call ours and gives DeleteAll<T>/Delete<T> their
	// early return, unless that's done. (FortRise relinks an assembly again when its checksum changes,
	// so the cache picks this up.)
	public static void Install(string modsDir, ILogger log)
	{
		string path = Directory.Exists(modsDir)
			? Directory.EnumerateFiles(modsDir, ExtensionsDll, SearchOption.AllDirectories).FirstOrDefault(p => !p.Contains("_RelinkerCache"))
			: null;
		if (path == null) return;
		// The game (for DirectFields to find entities' fields), FNA and the framework.
		using var resolver = new DefaultAssemblyResolver();
		foreach (string dir in new[] { BrowserHost.GameDir, BrowserHost.FortRiseDir, "/bin", Path.GetDirectoryName(path) })
		{
			if (Directory.Exists(dir)) resolver.AddSearchDirectory(dir);
		}
		using var module = ModuleDefinition.ReadModule(new MemoryStream(File.ReadAllBytes(path)), new ReaderParameters { AssemblyResolver = resolver });
		TypeDefinition extensions = module.GetType(LevelExtensions);
		MethodDefinition Generic(string name) => extensions?.Methods
			.FirstOrDefault(m => m.Name == name && m.HasGenericParameters && m.Parameters.Count == 1);
		MethodDefinition getAll = Generic("GetAll");
		if (getAll == null)
		{
			log.LogWarning("TF.State's GetAll<T> wasn't found; state saving stays unoptimized.");
			return;
		}
		static bool CallsUs(MethodDefinition m) =>
			m.Body.Instructions.Any(i => i.Operand is MethodReference r && r.DeclaringType.FullName == "TowerFallBrowser.StateSpeedups");

		var host = module.AssemblyReferences.FirstOrDefault(r => r.Name == "TowerFallBrowser");
		if (host == null)
		{
			host = new AssemblyNameReference("TowerFallBrowser", new Version(1, 0, 0, 0));
			module.AssemblyReferences.Add(host);
		}
		var speedups = new TypeReference("TowerFallBrowser", nameof(StateSpeedups), module, host);
		// StateSpeedups.Name<T>(object), called with the method's own T.
		GenericInstanceMethod Helper(string name, TypeReference returnType, MethodDefinition caller)
		{
			var helper = new MethodReference(name, module.TypeSystem.Void, speedups);
			var t = new GenericParameter("T", helper);
			helper.GenericParameters.Add(t);
			helper.ReturnType = returnType ?? module.TypeSystem.Boolean;
			if (returnType is GenericInstanceType g)
			{
				var r = new GenericInstanceType(g.ElementType);
				r.GenericArguments.Add(t);
				helper.ReturnType = r;
			}
			helper.Parameters.Add(new ParameterDefinition(module.TypeSystem.Object));
			var call = new GenericInstanceMethod(helper);
			call.GenericArguments.Add(caller.GenericParameters[0]);
			return call;
		}

		bool changed = false;
		if (!CallsUs(getAll))
		{
			// IEnumerable<T>, from the original's own return type (so it binds to the same assembly).
			var call = Helper(nameof(GetAll), getAll.ReturnType, getAll);
			getAll.Body.Instructions.Clear();
			getAll.Body.ExceptionHandlers.Clear();
			getAll.Body.Variables.Clear();
			ILProcessor il = getAll.Body.GetILProcessor();
			il.Emit(OpCodes.Ldarg_0);
			il.Emit(OpCodes.Call, call);
			il.Emit(OpCodes.Ret);
			changed = true;
		}
		foreach (string name in new[] { "DeleteAll", "Delete" })
		{
			MethodDefinition delete = Generic(name);
			if (delete == null || CallsUs(delete)) continue;
			// Only the code this was checked against: it does nothing when no entity is a T.
			string fingerprint = Fingerprint(delete);
			if (!KnownDeletes.Contains(fingerprint))
			{
				log.LogWarning($"TF.State's {name}<T> changed ({fingerprint}); state loading stays unoptimized there.");
				continue;
			}
			// if (!AnyEntity<T>(level)) return;  then the original body.
			ILProcessor il = delete.Body.GetILProcessor();
			Instruction first = delete.Body.Instructions[0];
			il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
			il.InsertBefore(first, il.Create(OpCodes.Call, Helper(nameof(AnyEntity), null, delete)));
			il.InsertBefore(first, il.Create(OpCodes.Brtrue, first));
			il.InsertBefore(first, il.Create(OpCodes.Ret));
			changed = true;
		}
		// GetEntityByDepth(level, depth): if (EntityByDepthOn()) return (Entity)EntityByDepth(GetGameplayLayer(level), depth);
		MethodDefinition byDepth = extensions.Methods.FirstOrDefault(m => m.Name == "GetEntityByDepth" && m.Parameters.Count == 2 && !m.HasGenericParameters);
		MethodDefinition gameplayLayer = extensions.Methods.FirstOrDefault(m => m.Name == "GetGameplayLayer" && m.Parameters.Count == 1 && !m.HasGenericParameters);
		if (byDepth != null && gameplayLayer != null && !CallsUs(byDepth))
		{
			string fingerprint = Fingerprint(byDepth);
			if (!KnownByDepth.Contains(fingerprint))
			{
				log.LogWarning($"TF.State's GetEntityByDepth changed ({fingerprint}); it stays as it is.");
			}
			else
			{
				var on = new MethodReference(nameof(EntityByDepthOn), module.TypeSystem.Boolean, speedups);
				var find = new MethodReference(nameof(EntityByDepth), module.TypeSystem.Object, speedups);
				find.Parameters.Add(new ParameterDefinition(module.TypeSystem.Object));
				find.Parameters.Add(new ParameterDefinition(module.TypeSystem.Double));
				ILProcessor il = byDepth.Body.GetILProcessor();
				Instruction first = byDepth.Body.Instructions[0];
				il.InsertBefore(first, il.Create(OpCodes.Call, on));
				il.InsertBefore(first, il.Create(OpCodes.Brfalse, first));
				il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
				il.InsertBefore(first, il.Create(OpCodes.Call, gameplayLayer));
				il.InsertBefore(first, il.Create(OpCodes.Ldarg_1));
				il.InsertBefore(first, il.Create(OpCodes.Call, find));
				il.InsertBefore(first, il.Create(OpCodes.Castclass, byDepth.ReturnType));
				il.InsertBefore(first, il.Create(OpCodes.Ret));
				changed = true;
			}
		}
		// CompareDepth(a, b): if (EntityByDepthOn()) return CompareDepth(a, b);
		MethodDefinition compare = extensions.Methods.FirstOrDefault(m => m.Name == "CompareDepth" && m.Parameters.Count == 2 && m.ReturnType.FullName == "System.Int32");
		if (compare != null && !CallsUs(compare))
		{
			string fingerprint = Fingerprint(compare);
			if (!KnownCompareDepth.Contains(fingerprint))
			{
				log.LogWarning($"TF.State's CompareDepth changed ({fingerprint}); it stays as it is.");
			}
			else
			{
				var on = new MethodReference(nameof(EntityByDepthOn), module.TypeSystem.Boolean, speedups);
				var ours = new MethodReference(nameof(CompareDepth), module.TypeSystem.Int32, speedups);
				ours.Parameters.Add(new ParameterDefinition(module.TypeSystem.Object));
				ours.Parameters.Add(new ParameterDefinition(module.TypeSystem.Object));
				ILProcessor il = compare.Body.GetILProcessor();
				Instruction first = compare.Body.Instructions[0];
				il.InsertBefore(first, il.Create(OpCodes.Call, on));
				il.InsertBefore(first, il.Create(OpCodes.Brfalse, first));
				il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
				il.InsertBefore(first, il.Create(OpCodes.Ldarg_1));
				il.InsertBefore(first, il.Create(OpCodes.Call, ours));
				il.InsertBefore(first, il.Create(OpCodes.Ret));
				changed = true;
			}
		}
		try
		{
			changed |= DirectFields.Rewrite(module, log) > 0;
		}
		catch (Exception e)
		{
			log.LogWarning($"Direct field access not set up: {e.Message}");
		}
		if (!changed) return;
		foreach (Resource old in module.Resources.Where(r => r.Name == StampResource).ToList()) module.Resources.Remove(old);
		module.Resources.Add(new EmbeddedResource(StampResource, Mono.Cecil.ManifestResourceAttributes.Private, System.Text.Encoding.UTF8.GetBytes(AdaptationVersion)));
		module.Write(path);
		File.Delete(Path.ChangeExtension(path, ".pdb")); // no longer matches
		log.LogInformation("Optimized TF.State's entity lookups for the browser.");
	}

	// TF.State's DeleteAll<T> and Delete<T> as of TF.EX 0.19.1.
	private static readonly HashSet<string> KnownDeletes = new() { "481292EF73EBD794", "01F1BC1FAAE9929D" };

	// TF.State's GetEntityByDepth as of TF.EX 0.21.1.
	private static readonly HashSet<string> KnownByDepth = new() { "B251F3A725774B59" };

	// TF.State's CompareDepth as of TF.EX 0.21.1.
	private static readonly HashSet<string> KnownCompareDepth = new() { "1DC08C56936598E0" };

	private static string Fingerprint(MethodDefinition m)
	{
		var text = string.Join("\n", m.Body.Instructions.Select(i => $"{i.OpCode} {(i.Operand is Instruction t ? t.Offset : i.Operand)}"));
		return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text)))[..16];
	}

	// Whether the TF.State DLL in a mod folder was adapted by a build other than this one (another
	// stamp, or none on a copy that calls into the host), so it must be extracted again from its zip
	// before Install. A copy nothing has adapted yet is fine as it is.
	public static bool NeedsFreshCopy(string modFolder)
	{
		string path = Directory.Exists(modFolder)
			? Directory.EnumerateFiles(modFolder, ExtensionsDll, SearchOption.AllDirectories).FirstOrDefault(p => !p.Contains("_RelinkerCache"))
			: null;
		if (path == null) return false;
		try
		{
			using var module = ModuleDefinition.ReadModule(path);
			if (!module.AssemblyReferences.Any(r => r.Name == "TowerFallBrowser")) return false;
			var stamp = module.Resources.OfType<EmbeddedResource>().FirstOrDefault(r => r.Name == StampResource);
			return stamp == null || System.Text.Encoding.UTF8.GetString(stamp.GetResourceData()) != AdaptationVersion;
		}
		catch (Exception)
		{
			return true; // unreadable: start over from the zip
		}
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

		// The fields DirectFields reads and writes directly, checked against the types as loaded.
		try
		{
			AssemblyName extensionsName = api.Assembly.GetReferencedAssemblies().FirstOrDefault(n => n.Name == Path.GetFileNameWithoutExtension(ExtensionsDll));
			var extensionsContext = System.Runtime.Loader.AssemblyLoadContext.GetLoadContext(api.Assembly);
			Assembly extensionsAssembly = extensionsName == null ? null : extensionsContext.LoadFromAssemblyName(extensionsName);
			DirectFields.Validate(extensionsAssembly);
			SetUpEntityByDepth(extensionsAssembly?.GetType(LevelExtensions));
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"[netplay] Direct field access stays off: {e.Message}");
		}

		// The sound and match-stats snapshots TF.State takes with every save. (Mods live in FortRise's
		// own load context, so TF.State.Domain is loaded through that.)
		try
		{
			var context = System.Runtime.Loader.AssemblyLoadContext.GetLoadContext(api.Assembly);
			AssemblyName domainName = api.Assembly.GetReferencedAssemblies().FirstOrDefault(n => n.Name == "TF.State.Domain");
			Assembly domain = domainName == null ? null : context.LoadFromAssemblyName(domainName);
			foreach (string service in new[] { "TF.State.Domain.Services.SFXService", "TF.State.Domain.Services.MatchStatsService" })
			{
				MethodInfo save = domain?.GetType(service)?.GetMethod("SaveSnapshot", BindingFlags.Public | BindingFlags.Instance);
				if (save == null) continue;
				harmony.Patch(save, transpiler: new HarmonyMethod(typeof(StateSpeedups).GetMethod(nameof(CheaperPrune), flags)));
			}
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"[netplay] TF.State's snapshot pruning stays unoptimized: {e.Message}");
		}
	}

	// SaveSnapshot(frame, ...) keeps 960 frames of snapshots in a Dictionary<int, ...> and, on every save,
	// finds the ones to drop with `foreach (var stale in dict.Keys.Where(f => f < cutoff).ToList())
	// dict.Remove(stale);`, a scan of all 960 keys. Here the list comes from StaleKeys instead: the same
	// keys, found by checking only the frames below the cutoff that could still be there. The loop
	// that removes them is unchanged, so the dictionary ends up the same.
	private static IEnumerable<CodeInstruction> CheaperPrune(IEnumerable<CodeInstruction> instructions, MethodBase __originalMethod)
	{
		var code = instructions.ToList();
		// [dict] callvirt get_Keys; ldloc closure; ...the lambda's delegate (cached in the closure)...;
		// call Where; call ToList
		int keysAt = code.FindIndex(c => c.operand is MethodInfo { Name: "get_Keys", DeclaringType: { IsGenericType: true } d }
			&& d.GetGenericTypeDefinition() == typeof(Dictionary<,>) && d.GetGenericArguments()[0] == typeof(int));
		int toListAt = keysAt < 0 ? -1 : code.FindIndex(keysAt, c => c.operand is MethodInfo { Name: "ToList" });
		FieldInfo cutoff = keysAt < 0 || toListAt < 0 ? null : code.Skip(keysAt).Take(toListAt - keysAt)
			.Select(c => (c.operand as MemberInfo)?.DeclaringType?.GetField("cutoff"))
			.FirstOrDefault(f => f?.FieldType == typeof(int));
		if (cutoff != null && toListAt - keysAt <= 16 && code[keysAt + 1].IsLdloc()
			&& code[toListAt - 1].operand is MethodInfo { Name: "Where" }
			&& code.Skip(keysAt + 2).Take(toListAt - keysAt - 2).All(c => c.labels.Count == 0 || code.Skip(keysAt).Take(toListAt - keysAt).Any(b => b.operand is System.Reflection.Emit.Label l && c.labels.Contains(l))))
		{
			// [dict] ldloc closure; ldfld cutoff; ldarg.1 (frame); call StaleKeys
			CodeInstruction closure = code[keysAt + 1].Clone();
			closure.labels.AddRange(code[keysAt].labels);
			code.RemoveRange(keysAt, toListAt - keysAt + 1);
			code.InsertRange(keysAt, new[]
			{
				closure,
				new CodeInstruction(System.Reflection.Emit.OpCodes.Ldfld, cutoff),
				new CodeInstruction(System.Reflection.Emit.OpCodes.Ldarg_1),
				new CodeInstruction(System.Reflection.Emit.OpCodes.Call, typeof(StateSpeedups).GetMethod(nameof(StaleKeys))),
			});
			return code;
		}
		Console.Error.WriteLine($"[netplay] {__originalMethod.DeclaringType?.Name}.SaveSnapshot changed; its snapshot pruning stays unoptimized.");
		return code;
	}

	private sealed class Pruned
	{
		public bool Started;
		public int Lowest = int.MaxValue; // no key is below this
	}

	private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, Pruned> pruned = new();

	// The keys below cutoff in a Dictionary<int, ...> that only ever gains `frame` between calls.
	public static List<int> StaleKeys(object dictionary, int cutoff, int frame)
	{
		var dict = (IDictionary)dictionary;
		Pruned state = pruned.GetValue(dictionary, static _ => new Pruned());
		if (!state.Started)
		{
			foreach (object key in dict.Keys) state.Lowest = Math.Min(state.Lowest, (int)key);
			state.Started = true;
		}
		if (frame < state.Lowest) state.Lowest = frame;
		var stale = new List<int>();
		if (cutoff > state.Lowest)
		{
			if ((long)cutoff - state.Lowest <= dict.Count)
			{
				for (int f = state.Lowest; f < cutoff; f++)
				{
					if (dict.Contains(f)) stale.Add(f);
				}
			}
			else
			{
				foreach (object key in dict.Keys)
				{
					if ((int)key < cutoff) stale.Add((int)key);
				}
			}
			state.Lowest = cutoff; // the caller removes them all
		}
		return stale;
	}

	private static bool entityByDepthOn;
	private static FieldInfo actualDepthField;
	private static Func<object, double> actualDepthGetter;
	private static readonly Dictionary<Type, bool> depthIsField = new();

	public static bool EntityByDepthOn() => entityByDepthOn;

	// LevelExtensions.GetEntityByDepth: the first entity of the gameplay layer, in list order, whose
	// actualDepth equals `actualDepth`, or null. (The original searched a copy of the list; nothing changes
	// the list during the search.)
	public static object EntityByDepth(object gameplayLayer, double actualDepth)
	{
		var entities = (IList)LayerLists.For(gameplayLayer).Entities(gameplayLayer);
		for (int i = 0, n = entities.Count; i < n; i++)
		{
			object entity = entities[i];
			if (ActualDepth(entity) == actualDepth) return entity;
		}
		return null;
	}

	// LevelExtensions.CompareDepth: Math.Sign(b's actualDepth - a's).
	public static int CompareDepth(object a, object b) => Math.Sign(ActualDepth(b) - ActualDepth(a));

	// DynamicData.For(entity).Get<double>("actualDepth"), reading Monocle.Entity's field directly when that's
	// the member DynamicData finds for the entity's type.
	private static double ActualDepth(object entity)
	{
		Type type = entity.GetType();
		if (!depthIsField.TryGetValue(type, out bool direct)) depthIsField[type] = direct = ResolvesTo(type, "actualDepth", actualDepthField);
		return direct ? actualDepthGetter(entity) : MonoMod.Utils.DynamicData.For(entity).Get<double>("actualDepth");
	}

	// Whether DynamicData, walking up from `type`, finds `name` as `field` (no class in between declares a field
	// or property of that name).
	private static bool ResolvesTo(Type type, string name, FieldInfo field)
	{
		const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
		for (Type t = type; t != null; t = t.BaseType)
		{
			if (t == field.DeclaringType) return true;
			if (t.GetField(name, all) != null || t.GetProperty(name, all) != null) return false;
		}
		return false;
	}

	private static void SetUpEntityByDepth(Type extensions)
	{
		if (Environment.GetEnvironmentVariable("TOWERFALL_ENTITYBYDEPTH") == "0") return;
		Type entity = extensions?.GetMethod("GetEntityByDepth", BindingFlags.Public | BindingFlags.Static)?.ReturnType;
		actualDepthField = entity?.GetField("actualDepth", BindingFlags.NonPublic | BindingFlags.Instance);
		if (actualDepthField?.FieldType != typeof(double)) return;
		var dm = new System.Reflection.Emit.DynamicMethod("ActualDepth", typeof(double), new[] { typeof(object) }, typeof(StateSpeedups).Module, skipVisibility: true);
		var il = dm.GetILGenerator();
		il.Emit(System.Reflection.Emit.OpCodes.Ldarg_0);
		il.Emit(System.Reflection.Emit.OpCodes.Castclass, entity);
		il.Emit(System.Reflection.Emit.OpCodes.Ldfld, actualDepthField);
		il.Emit(System.Reflection.Emit.OpCodes.Ret);
		actualDepthGetter = (Func<object, double>)dm.CreateDelegate(typeof(Func<object, double>));
		entityByDepthOn = true;
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
		// Outside a save (loading a state adds and removes entities while it works), keep the
		// original's lazy semantics: entities are read when the result is enumerated.
		if (!capturing)
		{
			return Lazy<T>(level);
		}
		if (snapshotLevel != level)
		{
			TakeSnapshot(level);
			snapshotLevel = level;
		}
		var result = new List<T>();
		object[] all = snapshot;
		for (int i = 0, n = snapshotCount; i < n; i++)
		{
			if (all[i] is T entity) result.Add(entity);
		}
		return result;
	}

	private static IEnumerable<T> Lazy<T>(object level)
	{
		layersProperty ??= level.GetType().GetProperty("Layers");
		foreach (DictionaryEntry layer in (IDictionary)layersProperty.GetValue(level))
		{
			entitiesProperty ??= layer.Value.GetType().GetProperty("Entities");
			foreach (object entity in (IEnumerable)entitiesProperty.GetValue(layer.Value))
			{
				if (entity is T t) yield return t;
			}
		}
	}

	// Whether any layer of the level has a T among its entities or pending adds (Layer.toAdd), which is
	// all DeleteAll<T>/Delete<T> touch. Each list's answer is kept until the list changes (List<T>
	// counts its changes in _version).
	public static bool AnyEntity<T>(object level)
	{
		layersProperty ??= level.GetType().GetProperty("Layers");
		foreach (DictionaryEntry layer in (IDictionary)layersProperty.GetValue(level))
		{
			LayerLists lists = LayerLists.For(layer.Value);
			if (Holds<T>((IList)lists.Entities(layer.Value)) || Holds<T>((IList)lists.ToAdd(layer.Value))) return true;
		}
		return false;
	}

	private sealed class Answer
	{
		public int Version = -1;
		public bool Holds;
	}

	private static class Answers<T>
	{
		public static readonly System.Runtime.CompilerServices.ConditionalWeakTable<IList, Answer> ByList = new();
	}

	private static bool Holds<T>(IList list)
	{
		if (list == null) return false;
		Answer answer = Answers<T>.ByList.GetValue(list, static _ => new Answer());
		int version = LayerLists.Version(list);
		if (answer.Version != version)
		{
			bool holds = false;
			for (int i = 0, n = list.Count; i < n && !holds; i++) holds = list[i] is T;
			answer.Holds = holds;
			answer.Version = version;
		}
		return answer.Holds;
	}

	// Compiled getters for a Monocle.Layer's Entities and toAdd lists and a List<Entity>'s _version.
	private sealed class LayerLists
	{
		private static LayerLists instance;
		private static Type versionType;
		private static Func<object, int> version;
		public Func<object, object> Entities;
		public Func<object, object> ToAdd;

		public static LayerLists For(object layer) => instance ??= new LayerLists
		{
			Entities = Getter(layer.GetType().GetProperty("Entities").GetGetMethod(), null),
			ToAdd = Getter(null, layer.GetType().GetField("toAdd", BindingFlags.NonPublic | BindingFlags.Instance)),
		};

		public static int Version(IList list)
		{
			if (versionType != list.GetType())
			{
				FieldInfo field = list.GetType().GetField("_version", BindingFlags.NonPublic | BindingFlags.Instance);
				var dm = new System.Reflection.Emit.DynamicMethod("ListVersion", typeof(int), new[] { typeof(object) }, typeof(StateSpeedups).Module, skipVisibility: true);
				var il = dm.GetILGenerator();
				il.Emit(System.Reflection.Emit.OpCodes.Ldarg_0);
				il.Emit(System.Reflection.Emit.OpCodes.Castclass, list.GetType());
				il.Emit(System.Reflection.Emit.OpCodes.Ldfld, field);
				il.Emit(System.Reflection.Emit.OpCodes.Ret);
				version = (Func<object, int>)dm.CreateDelegate(typeof(Func<object, int>));
				versionType = list.GetType();
			}
			return version(list);
		}

		private static Func<object, object> Getter(MethodInfo getter, FieldInfo field)
		{
			Type owner = getter?.DeclaringType ?? field.DeclaringType;
			var dm = new System.Reflection.Emit.DynamicMethod("LayerList", typeof(object), new[] { typeof(object) }, typeof(StateSpeedups).Module, skipVisibility: true);
			var il = dm.GetILGenerator();
			il.Emit(System.Reflection.Emit.OpCodes.Ldarg_0);
			il.Emit(System.Reflection.Emit.OpCodes.Castclass, owner);
			if (getter != null) il.Emit(System.Reflection.Emit.OpCodes.Callvirt, getter);
			else il.Emit(System.Reflection.Emit.OpCodes.Ldfld, field);
			il.Emit(System.Reflection.Emit.OpCodes.Ret);
			return (Func<object, object>)dm.CreateDelegate(typeof(Func<object, object>));
		}
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
