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
// Same entities, same order, so the state is byte-for-byte what TF.State would produce (other players
// and replays rely on that).
public static class StateSpeedups
{
	private const string ExtensionsDll = "TF.State.TowerFallExtensions.dll";
	private const string LevelExtensions = "TF.State.TowerFallExtensions.LevelExtensions";

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
		using var module = ModuleDefinition.ReadModule(new MemoryStream(File.ReadAllBytes(path)));
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
		if (!changed) return;
		module.Write(path);
		File.Delete(Path.ChangeExtension(path, ".pdb")); // no longer matches
		log.LogInformation("Optimized TF.State's entity lookups for the browser.");
	}

	// TF.State's DeleteAll<T> and Delete<T> as of TF.EX 0.19.1.
	private static readonly HashSet<string> KnownDeletes = new() { "481292EF73EBD794", "01F1BC1FAAE9929D" };

	private static string Fingerprint(MethodDefinition m)
	{
		var text = string.Join("\n", m.Body.Instructions.Select(i => $"{i.OpCode} {(i.Operand is Instruction t ? t.Offset : i.Operand)}"));
		return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text)))[..16];
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
