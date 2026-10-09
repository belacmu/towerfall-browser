// Checks whether an unmodified TowerFall.exe can bind to a given set of assemblies: every type
// and member reference into each referenced assembly must resolve. Usage:
//   RefCheck <TowerFall.exe> <dir with replacement assemblies>...
using Mono.Cecil;

var exePath = args[0];
var resolver = new DefaultAssemblyResolver();
foreach (var dir in args.Skip(1)) resolver.AddSearchDirectory(dir);
var module = ModuleDefinition.ReadModule(exePath, new ReaderParameters { AssemblyResolver = resolver });

Console.WriteLine($"{module.Assembly.Name} ({module.RuntimeVersion})");
foreach (var r in module.AssemblyReferences) Console.WriteLine($"  references {r.FullName}");

var failures = new SortedDictionary<string, SortedSet<string>>();
void Fail(string scope, string what)
{
	if (!failures.TryGetValue(scope, out var set)) failures[scope] = set = new SortedSet<string>();
	set.Add(what);
}
string Scope(TypeReference t) => (t.GetElementType().Scope as AssemblyNameReference)?.Name ?? t.Scope?.Name ?? "?";

foreach (var t in module.GetTypeReferences())
{
	if (t.Scope is not AssemblyNameReference) continue;
	try { if (t.Resolve() == null) Fail(Scope(t), "type " + t.FullName); }
	catch (Exception e) { Fail(Scope(t), $"type {t.FullName} ({e.GetType().Name})"); }
}
foreach (var m in module.GetMemberReferences())
{
	var declaring = m.DeclaringType;
	if (declaring == null || declaring.GetElementType().Scope is not AssemblyNameReference) continue;
	try
	{
		IMemberDefinition def = m switch
		{
			MethodReference mr => mr.Resolve(),
			FieldReference fr => fr.Resolve(),
			_ => null
		};
		if (def == null) Fail(Scope(declaring), m.FullName);
	}
	catch (Exception e) { Fail(Scope(declaring), $"{m.FullName} ({e.GetType().Name}: {e.Message})"); }
}

if (failures.Count == 0) Console.WriteLine("All type and member references resolve.");
foreach (var (scope, items) in failures)
{
	Console.WriteLine($"\n{scope}: {items.Count} unresolved");
	foreach (var i in items) Console.WriteLine("  " + i);
}
