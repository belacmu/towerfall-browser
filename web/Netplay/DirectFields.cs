using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Mono.Cecil;
using Mono.Cecil.Cil;
using MethodBody = Mono.Cecil.Cil.MethodBody;
using Mono.Cecil.Rocks;

namespace TowerFallBrowser;

// TF.State reads and writes entities' private fields by name through MonoMod's DynamicData, about a
// thousand places, many of them for every player on every save and load:
//     var dyn = DynamicData.For(entity);  ...  dyn.Get<float>("wallStickMax")  ...  dyn.Set("counter", v)
// Each such call looks the name up in tables for the object's type and goes through a delegate and a
// box. Where the object is a parameter or a local that's set once, and its declared type has a field of
// that name, the call is rewritten (in the installed DLL) to read or write the field directly, behind a
// check that the object's type is exactly the declared type (so a subclass, which DynamicData would
// look at first, still goes the old way) and that the run-time check below passed:
//     DirectFields.Is(entity, typeof(Player)) ? entity.wallStickMax : dyn.Get<float>("wallStickMax")
// DynamicData resolves a name from the object's type upwards, fields before properties at each level;
// the field chosen here is the one it would choose for that type. At run time, before any of this is
// used, Validate checks each rewritten (type, name, field) against the loaded types (FortRise patches
// the game, mods add types) and leaves everything on the old path if any differs.
public static class DirectFields
{
	private const string ResourceName = "TowerFallBrowser.DirectFields";

	// Set by Validate.
	public static bool Enabled;

	public static bool Is(object obj, RuntimeTypeHandle type) => Enabled && obj != null && Type.GetTypeHandle(obj).Equals(type);

	// --- Install time ----------------------------------------------------------------------

	// Rewrites every method of the module; returns how many accesses.
	public static int Rewrite(ModuleDefinition module, ILogger log)
	{
		if (module.Resources.Any(r => r.Name == ResourceName)) return 0;
		var host = module.AssemblyReferences.FirstOrDefault(r => r.Name == "TowerFallBrowser");
		if (host == null)
		{
			host = new AssemblyNameReference("TowerFallBrowser", new Version(1, 0, 0, 0));
			module.AssemblyReferences.Add(host);
		}
		var directFields = new TypeReference("TowerFallBrowser", nameof(DirectFields), module, host);
		var isMethod = new MethodReference(nameof(Is), module.TypeSystem.Boolean, directFields);
		isMethod.Parameters.Add(new ParameterDefinition(module.TypeSystem.Object));
		isMethod.Parameters.Add(new ParameterDefinition(module.ImportReference(typeof(RuntimeTypeHandle))));

		var sites = new SortedSet<string>(StringComparer.Ordinal);
		int count = 0, skipped = 0;
		foreach (TypeDefinition type in module.GetTypes())
		{
			foreach (MethodDefinition method in type.Methods.Where(m => m.HasBody))
			{
				try
				{
					count += RewriteMethod(module, method, isMethod, sites);
				}
				catch (Exception e)
				{
					skipped++;
					log.LogDebug($"DirectFields: {method.FullName} left as is: {e.Message}");
				}
			}
		}
		if (count == 0) return 0;
		module.Resources.Add(new EmbeddedResource(ResourceName, Mono.Cecil.ManifestResourceAttributes.Private, System.Text.Encoding.UTF8.GetBytes(string.Join("\n", sites))));
		log.LogInformation($"Direct field access at {count} places in {module.Name} ({sites.Count} fields){(skipped > 0 ? $", {skipped} methods skipped" : "")}.");
		return count;
	}

	private static bool IsDynamicData(TypeReference t) => t.FullName == "MonoMod.Utils.DynamicData";

	private static int RewriteMethod(ModuleDefinition module, MethodDefinition method, MethodReference isMethod, SortedSet<string> sites)
	{
		var body = method.Body;
		var ins = body.Instructions;
		// Locals and parameters stored more than once can't stand in for the object later.
		var localStores = new Dictionary<int, int>();
		var argStores = new HashSet<int>();
		foreach (Instruction i in ins)
		{
			if (StoredLocal(i, body) is int l) localStores[l] = localStores.GetValueOrDefault(l) + 1;
			if (i.OpCode.Code is Code.Starg or Code.Starg_S) argStores.Add(((ParameterDefinition)i.Operand).Sequence);
			if (i.OpCode.Code is Code.Ldloca or Code.Ldloca_S) localStores[((VariableDefinition)i.Operand).Index] = 99;
			if (i.OpCode.Code is Code.Ldarga or Code.Ldarga_S) argStores.Add(((ParameterDefinition)i.Operand).Sequence);
		}

		// dyn local -> (instruction loading the object, the object's declared type)
		var dyns = new Dictionary<int, (Instruction Load, TypeReference Type)>();
		for (int k = 2; k < ins.Count; k++)
		{
			if (ins[k - 1].OpCode.Code != Code.Call || ins[k - 1].Operand is not MethodReference { Name: "For" } f || !IsDynamicData(f.DeclaringType)) continue;
			if (StoredLocal(ins[k], body) is not int dyn || localStores.GetValueOrDefault(dyn) != 1) continue;
			(Instruction load, TypeReference objType) = Source(ins[k - 2], body, method, localStores, argStores);
			if (load == null || objType == null || objType.IsValueType || objType.IsGenericParameter || objType.IsArray) continue;
			if (objType.ContainsGenericParameter && objType is not GenericInstanceType) continue;
			dyns[dyn] = (load, objType);
		}
		if (dyns.Count == 0) return 0;

		// Find every site first (the code put in for one contains the same pattern again).
		var gets = new List<(Instruction First, Instruction Call, (Instruction Load, TypeReference Type) Obj, Member Member, TypeReference Wanted)>();
		var sets = new List<(Instruction First, Instruction Ldstr, Instruction Before, Instruction Set, bool Boxed, (Instruction Load, TypeReference Type) Obj, Member Member)>();
		for (int k = 0; k + 2 < ins.Count; k++)
		{
			if (LoadedLocal(ins[k], body) is not int dyn || !dyns.TryGetValue(dyn, out var obj)) continue;
			if (ins[k + 1].OpCode.Code != Code.Ldstr) continue;
			string name = (string)ins[k + 1].Operand;
			if (ins[k + 2].Operand is GenericInstanceMethod { Name: "Get", Parameters.Count: 1 } get && IsDynamicData(get.DeclaringType) && ins[k + 2].OpCode.Code == Code.Callvirt)
			{
				TypeReference wanted = get.GenericArguments[0];
				Member member = Resolve(module, obj.Type, name, get: true, set: false);
				if (member == null || !GetMatches(member.Type, wanted)) continue;
				gets.Add((ins[k], ins[k + 2], obj, member, wanted));
				continue;
			}
			// [dyn] ldstr name; <value>; [box V]; callvirt Set(string, object)
			int setAt = FindSet(ins, k + 2);
			if (setAt < 0) continue;
			Member setMember = Resolve(module, obj.Type, name, get: false, set: true);
			if (setMember == null) continue;
			Instruction before = ins[setAt - 1];
			bool boxed = before.OpCode.Code == Code.Box;
			if (boxed)
			{
				// Only an exactly matching boxed value, unboxed again by the setter, can go straight in.
				if (!Same((TypeReference)before.Operand, setMember.Type)) continue;
			}
			else if (setMember.Type.IsValueType || setMember.Type.IsGenericParameter || setMember.Type.ContainsGenericParameter)
			{
				continue;
			}
			sets.Add((ins[k], ins[k + 1], before, ins[setAt], boxed, obj, setMember));
		}
		if (gets.Count + sets.Count == 0) return 0;

		// Long branches while code goes in; short ones again after.
		body.SimplifyMacros();
		// Sets first: a Get inside a Set's value then still continues into the Set's new code.
		foreach (var x in sets)
		{
			EmitSet(body, x.First, x.Ldstr, x.Before, x.Set, x.Boxed, x.Obj.Load, x.Obj.Type, x.Member, isMethod);
			sites.Add(x.Member.Site);
		}
		foreach (var x in gets)
		{
			EmitGet(body, x.First, x.Call, x.Obj.Load, x.Obj.Type, x.Member, x.Wanted, isMethod);
			sites.Add(x.Member.Site);
		}
		body.OptimizeMacros();
		return gets.Count + sets.Count;
	}

	private static int? StoredLocal(Instruction i, MethodBody body) => i.OpCode.Code switch
	{
		Code.Stloc_0 => 0, Code.Stloc_1 => 1, Code.Stloc_2 => 2, Code.Stloc_3 => 3,
		Code.Stloc or Code.Stloc_S => ((VariableDefinition)i.Operand).Index,
		_ => null,
	};

	private static int? LoadedLocal(Instruction i, MethodBody body) => i.OpCode.Code switch
	{
		Code.Ldloc_0 => 0, Code.Ldloc_1 => 1, Code.Ldloc_2 => 2, Code.Ldloc_3 => 3,
		Code.Ldloc or Code.Ldloc_S => ((VariableDefinition)i.Operand).Index,
		_ => null,
	};

	// The object passed to For: a parameter never stored to, or a local stored once.
	private static (Instruction, TypeReference) Source(Instruction i, MethodBody body, MethodDefinition method, Dictionary<int, int> localStores, HashSet<int> argStores)
	{
		if (LoadedLocal(i, body) is int l)
		{
			return localStores.GetValueOrDefault(l) == 1 ? (Instruction.Create(OpCodes.Ldloc, body.Variables[l]), body.Variables[l].VariableType) : (null, null);
		}
		int arg = i.OpCode.Code switch
		{
			Code.Ldarg_0 => 0, Code.Ldarg_1 => 1, Code.Ldarg_2 => 2, Code.Ldarg_3 => 3,
			Code.Ldarg or Code.Ldarg_S => ((ParameterDefinition)i.Operand).Sequence,
			_ => -1,
		};
		if (arg < 0 || argStores.Contains(arg)) return (null, null);
		if (method.HasThis && arg == 0) return (Instruction.Create(OpCodes.Ldarg_0), method.DeclaringType);
		ParameterDefinition p = method.Parameters[arg - (method.HasThis ? 1 : 0)];
		return (Instruction.Create(OpCodes.Ldarg, p), p.ParameterType);
	}

	// What a direct access uses in place of DynamicData's lookup: a field, or a property's accessors.
	private sealed class Member
	{
		public FieldReference Field;
		public MethodReference Getter, Setter;
		public TypeReference Type; // in terms of the object's type (its generic arguments put in)
		public string Site;
	}

	// The member DynamicData would find for `name` on an object of exactly `type`: walking up from the
	// type, the first level with a field (static or instance) or property of that name decides, a field
	// before a property. Only instance members; for a property, the accessors needed must be on it
	// (DynamicData would otherwise take another level's or store the value on the side).
	private static Member Resolve(ModuleDefinition module, TypeReference type, string name, bool get, bool set)
	{
		for (TypeReference t = type; t != null;)
		{
			TypeDefinition def = t.Resolve();
			if (def == null) return null;
			var generic = t as GenericInstanceType;
			if (def.HasGenericParameters != (generic != null)) return null;
			string typeName = (generic?.ElementType ?? t).Resolve().FullName;
			string objName = type is GenericInstanceType g ? g.ElementType.Resolve().FullName : type.Resolve().FullName;
			FieldDefinition field = def.Fields.FirstOrDefault(f => f.Name == name);
			if (field != null)
			{
				if (field.IsStatic) return null;
				TypeReference fieldType = Substitute(field.FieldType, generic);
				if (fieldType == null) return null;
				FieldReference imported = module.ImportReference(field);
				return new Member
				{
					Field = generic == null ? imported : new FieldReference(imported.Name, imported.FieldType, generic),
					Type = fieldType is GenericParameter ? fieldType : module.ImportReference(fieldType),
					Site = $"{objName}|{name}|{typeName}|F",
				};
			}
			PropertyDefinition prop = def.Properties.FirstOrDefault(p => p.Name == name);
			if (prop != null)
			{
				MethodDefinition getter = prop.GetMethod, setter = prop.SetMethod;
				if ((get && (getter == null || getter.IsStatic)) || (set && (setter == null || setter.IsStatic))) return null;
				TypeReference propType = Substitute(prop.PropertyType, generic);
				if (propType == null) return null;
				return new Member
				{
					Getter = get ? Accessor(module, getter, generic) : null,
					Setter = set ? Accessor(module, setter, generic) : null,
					Type = propType is GenericParameter ? propType : module.ImportReference(propType),
					Site = $"{objName}|{name}|{typeName}|{(get ? "G" : "S")}",
				};
			}
			// Bases that are themselves generic instances would need their arguments worked out; stop.
			if (def.BaseType is GenericInstanceType) return null;
			t = def.BaseType;
		}
		return null;
	}

	// A type as seen from a generic instance: the type's own parameters become the instance's arguments.
	private static TypeReference Substitute(TypeReference t, GenericInstanceType generic)
	{
		if (t is GenericParameter p)
		{
			if (generic == null || p.Type != GenericParameterType.Type) return null;
			return generic.GenericArguments[p.Position];
		}
		return t.ContainsGenericParameter ? null : t;
	}

	private static MethodReference Accessor(ModuleDefinition module, MethodDefinition m, GenericInstanceType generic)
	{
		MethodReference imported = module.ImportReference(m);
		if (generic == null) return imported;
		var r = new MethodReference(imported.Name, imported.ReturnType, generic) { HasThis = imported.HasThis, ExplicitThis = imported.ExplicitThis, CallingConvention = imported.CallingConvention };
		foreach (ParameterDefinition p in imported.Parameters) r.Parameters.Add(new ParameterDefinition(p.ParameterType));
		return r;
	}

	private static bool Same(TypeReference a, TypeReference b)
	{
		if (a is GenericParameter pa || b is GenericParameter)
		{
			return a is GenericParameter x && b is GenericParameter y && x.Type == y.Type && x.Position == y.Position;
		}
		return a.FullName == b.FullName;
	}

	// Get<T>'s (T) on the boxed value: the same as the value itself when the types match exactly, or a
	// castclass between reference types.
	private static bool GetMatches(TypeReference member, TypeReference wanted)
	{
		if (Same(member, wanted)) return true;
		bool known(TypeReference t) => !t.IsGenericParameter && !t.ContainsGenericParameter;
		return known(member) && known(wanted) && !member.IsValueType && !wanted.IsValueType;
	}

	// The Set(string, object) that consumes the value pushed after `start`: no branches in between,
	// and the stack never drops below the value's level.
	private static int FindSet(Mono.Collections.Generic.Collection<Instruction> ins, int start)
	{
		int depth = 0;
		for (int k = start; k < ins.Count && k < start + 40; k++)
		{
			Instruction i = ins[k];
			if (depth == 1 && i.OpCode.Code == Code.Callvirt && i.Operand is MethodReference { Name: "Set", Parameters.Count: 2 } set
				&& IsDynamicData(set.DeclaringType) && set.Parameters[0].ParameterType.FullName == "System.String" && set.Parameters[1].ParameterType.FullName == "System.Object")
			{
				return k;
			}
			if (i.OpCode.FlowControl is FlowControl.Branch or FlowControl.Cond_Branch or FlowControl.Return or FlowControl.Throw) return -1;
			int? pop = Pops(i), push = Pushes(i);
			if (pop == null || push == null) return -1;
			depth -= pop.Value;
			if (depth < 0) return -1;
			depth += push.Value;
		}
		return -1;
	}

	private static int? Pops(Instruction i)
	{
		if (i.Operand is MethodReference m && i.OpCode.Code is Code.Call or Code.Callvirt or Code.Newobj)
		{
			return m.Parameters.Count + (m.HasThis && i.OpCode.Code != Code.Newobj ? 1 : 0);
		}
		return i.OpCode.StackBehaviourPop switch
		{
			StackBehaviour.Pop0 => 0,
			StackBehaviour.Pop1 or StackBehaviour.Popi or StackBehaviour.Popref => 1,
			StackBehaviour.Pop1_pop1 or StackBehaviour.Popi_pop1 or StackBehaviour.Popi_popi or StackBehaviour.Popi_popi8 or StackBehaviour.Popi_popr4
				or StackBehaviour.Popi_popr8 or StackBehaviour.Popref_pop1 or StackBehaviour.Popref_popi => 2,
			StackBehaviour.Popi_popi_popi or StackBehaviour.Popref_popi_popi or StackBehaviour.Popref_popi_popi8 or StackBehaviour.Popref_popi_popr4
				or StackBehaviour.Popref_popi_popr8 or StackBehaviour.Popref_popi_popref => 3,
			_ => null,
		};
	}

	private static int? Pushes(Instruction i)
	{
		if (i.Operand is MethodReference m && i.OpCode.Code is Code.Call or Code.Callvirt or Code.Newobj)
		{
			return i.OpCode.Code == Code.Newobj || m.ReturnType.FullName != "System.Void" ? 1 : 0;
		}
		return i.OpCode.StackBehaviourPush switch
		{
			StackBehaviour.Push0 => 0,
			StackBehaviour.Push1 or StackBehaviour.Pushi or StackBehaviour.Pushi8 or StackBehaviour.Pushr4 or StackBehaviour.Pushr8 or StackBehaviour.Pushref => 1,
			StackBehaviour.Push1_push1 => 2,
			_ => null,
		};
	}

	// [ldloc dyn; ldstr name; callvirt Get<T>]  becomes
	//   obj; ldtoken Type; call Is; brfalse slow; obj; ldfld field; [castclass T]; br done
	//   slow: ldloc dyn; ldstr name; callvirt Get<T>
	//   done:
	// The first instruction object is reused, so branches and handlers that pointed at it still do.
	private static void EmitGet(MethodBody body, Instruction first, Instruction call, Instruction load, TypeReference objType, Member member, TypeReference wanted, MethodReference isMethod)
	{
		ILProcessor il = body.GetILProcessor();
		Instruction slow = Clone(first);
		Instruction done = call.Next;
		var fast = new List<Instruction>
		{
			Clone(load), Instruction.Create(OpCodes.Ldtoken, objType), Instruction.Create(OpCodes.Call, isMethod), Instruction.Create(OpCodes.Brfalse, slow),
			Clone(load), member.Field != null ? Instruction.Create(OpCodes.Ldfld, member.Field) : Instruction.Create(OpCodes.Callvirt, member.Getter),
		};
		if (!Same(member.Type, wanted)) fast.Add(Instruction.Create(OpCodes.Castclass, wanted));
		fast.Add(Instruction.Create(OpCodes.Br, done));
		// `first` becomes the start of the fast path; a new instruction takes its place in the slow one.
		Instruction head = fast[0];
		first.OpCode = head.OpCode;
		first.Operand = head.Operand;
		Instruction at = first;
		foreach (Instruction i in fast.Skip(1))
		{
			il.InsertAfter(at, i);
			at = i;
		}
		il.InsertAfter(at, slow);
	}

	// [ldloc dyn; ldstr name; <value>; [box V]; callvirt Set]  becomes
	//   <value>; obj; ldtoken Type; call Is; brfalse slow
	//   (stack: value) -> stloc tmp; obj; ldloc tmp; [castclass F]; stfld field; br done
	//   slow: [box V]; stloc tmpo; ldloc dyn; ldstr name; ldloc tmpo; callvirt Set
	//   done:
	private static void EmitSet(MethodBody body, Instruction first, Instruction ldstr, Instruction beforeSet, Instruction set, bool boxed, Instruction load, TypeReference objType, Member member, MethodReference isMethod)
	{
		ILProcessor il = body.GetILProcessor();
		TypeReference valueType = boxed ? (TypeReference)beforeSet.Operand : body.Method.Module.TypeSystem.Object;
		var tmp = new VariableDefinition(valueType);
		var tmpObj = new VariableDefinition(body.Method.Module.TypeSystem.Object);
		body.Variables.Add(tmp);
		body.Variables.Add(tmpObj);
		body.InitLocals = true;
		Instruction dynLoad = Clone(first);
		string name = (string)ldstr.Operand;
		Instruction done = set.Next;

		// The value now comes first: drop `ldloc dyn; ldstr name` from the front. `first` is reused as a
		// nop so anything that pointed at it still runs the value expression.
		first.OpCode = OpCodes.Nop;
		first.Operand = null;
		il.Remove(ldstr);
		if (boxed) il.Remove(beforeSet);

		var slow = new List<Instruction>();
		if (boxed) slow.Add(Instruction.Create(OpCodes.Box, valueType));
		slow.AddRange(new[] { Instruction.Create(OpCodes.Stloc, tmpObj), dynLoad, Instruction.Create(OpCodes.Ldstr, name), Instruction.Create(OpCodes.Ldloc, tmpObj) });
		Instruction slowStart = Instruction.Create(OpCodes.Ldloc, tmp);
		var code = new List<Instruction>
		{
			Instruction.Create(OpCodes.Stloc, tmp),
			Clone(load), Instruction.Create(OpCodes.Ldtoken, objType), Instruction.Create(OpCodes.Call, isMethod), Instruction.Create(OpCodes.Brfalse, slowStart),
			Clone(load), Instruction.Create(OpCodes.Ldloc, tmp),
		};
		if (!boxed && member.Type.FullName != "System.Object") code.Add(Instruction.Create(OpCodes.Castclass, member.Type));
		code.Add(member.Field != null ? Instruction.Create(OpCodes.Stfld, member.Field) : Instruction.Create(OpCodes.Callvirt, member.Setter));
		code.Add(Instruction.Create(OpCodes.Br, done));
		code.Add(slowStart);
		code.AddRange(slow);
		foreach (Instruction i in code)
		{
			il.InsertBefore(set, i);
		}
	}

	private static Instruction Clone(Instruction i) => i.Operand switch
	{
		VariableDefinition v => Instruction.Create(i.OpCode, v),
		ParameterDefinition p => Instruction.Create(i.OpCode, p),
		null => Instruction.Create(i.OpCode),
		_ => throw new NotSupportedException(i.ToString()),
	};

	// --- Run time --------------------------------------------------------------------------

	// Checks the rewritten fields against the types as loaded and turns the direct path on if they
	// all match what DynamicData would use.
	public static void Validate(Assembly rewritten)
	{
		using Stream s = rewritten?.GetManifestResourceStream(ResourceName);
		if (s == null) return;
		string[] sites = new StreamReader(s).ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
		var context = System.Runtime.Loader.AssemblyLoadContext.GetLoadContext(rewritten);
		Type Find(string fullName) => AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(fullName.Replace('/', '+'))).FirstOrDefault(t => t != null);
		foreach (string site in sites)
		{
			string[] p = site.Split('|');
			Type type = Find(p[0]);
			if (type == null || !Binds(type, p[1], p[2], p[3]))
			{
				Console.Error.WriteLine($"[netplay] Direct field access stays off: {p[0]}.{p[1]} isn't the member it was for.");
				return;
			}
		}
		Enabled = true;
		Console.WriteLine($"[netplay] Direct field access on ({sites.Length} members).");
	}

	// DynamicData's lookup for `name` from `type` upwards lands on `declaring`'s instance field (F), or
	// on its property with a getter (G) or setter (S).
	private static bool Binds(Type type, string name, string declaring, string kind)
	{
		const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
		for (Type t = type; t != null && t != t.BaseType; t = t.BaseType)
		{
			Type def = t.IsGenericType ? t.GetGenericTypeDefinition() : t;
			FieldInfo field = def.GetField(name, all);
			if (field != null) return kind == "F" && !field.IsStatic && def.FullName?.Replace('+', '/') == declaring;
			PropertyInfo prop = def.GetProperty(name, all);
			if (prop != null)
			{
				MethodInfo accessor = kind == "G" ? prop.GetGetMethod(true) : kind == "S" ? prop.GetSetMethod(true) : null;
				return accessor != null && !accessor.IsStatic && def.FullName?.Replace('+', '/') == declaring;
			}
		}
		return false;
	}
}
