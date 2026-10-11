// Compares two builds of an assembly method by method, by normalized IL: the "objdiff" for a
// decompile that is meant to rebuild the original (docs/DECOMP.md). Usage:
//   ILCompare <original.exe> <rebuilt.exe> [diff dir]
// Normalization: nops dropped, short/macro opcode forms folded (ldloc.0 == ldloc.s 0), branch
// targets as instruction indices, and the numbering in compiler-generated names erased
// (<Foo>d__12 == <Foo>d__3), since different compilers number them differently.
// With a diff dir, writes <method>.a.il / .b.il for every differing non-generated method.
using System.Text.RegularExpressions;
using Mono.Cecil;
using Mono.Cecil.Cil;
using Mono.Cecil.Rocks;

var a = ModuleDefinition.ReadModule(args[0]);
var b = ModuleDefinition.ReadModule(args[1]);
string diffDir = args.Length > 2 ? args[2] : null;

var rebuilt = AllTypes(b).SelectMany(t => t.Methods).GroupBy(m => Norm(m.FullName)).ToDictionary(g => g.Key, g => g.ToList());
int user = 0, generated = 0, exact = 0, exactGenerated = 0, unmatched = 0;
long countA = 0, countB = 0;
foreach (var type in AllTypes(a))
{
	foreach (var method in type.Methods)
	{
		bool gen = IsGenerated(type) || method.Name.Contains('<');
		if (gen) generated++; else user++;
		if (!rebuilt.TryGetValue(Norm(method.FullName), out var candidates))
		{
			unmatched++;
			if (!gen) Console.WriteLine($"not in rebuild: {method.FullName}");
			continue;
		}
		var seqA = Sequence(method);
		var seqB = candidates.Select(Sequence).OrderBy(s => Math.Abs(s.Count - seqA.Count)).First();
		countA += seqA.Count;
		countB += seqB.Count;
		if (seqA.SequenceEqual(seqB))
		{
			if (gen) exactGenerated++; else exact++;
		}
		else if (diffDir != null && !gen)
		{
			Directory.CreateDirectory(diffDir);
			string name = Regex.Replace(method.FullName, @"[^A-Za-z0-9]+", "_");
			if (name.Length > 150) name = name[..150] + "_" + (uint)method.FullName.GetHashCode();
			File.WriteAllLines(Path.Combine(diffDir, name + ".a.il"), seqA);
			File.WriteAllLines(Path.Combine(diffDir, name + ".b.il"), seqB);
		}
	}
}
Console.WriteLine($"methods: {user} written, {generated} compiler-generated; {unmatched} not found in the rebuild");
Console.WriteLine($"exact IL match: {exact} written ({100.0 * exact / user:F1}%), {exactGenerated} generated ({100.0 * exactGenerated / generated:F1}%)");
Console.WriteLine($"instructions (without nops): original {countA}, rebuilt {countB}");

static IEnumerable<TypeDefinition> AllTypes(ModuleDefinition m) => m.Types.SelectMany(Flatten);
static IEnumerable<TypeDefinition> Flatten(TypeDefinition t) => new[] { t }.Concat(t.NestedTypes.SelectMany(Flatten));

static bool IsGenerated(TypeReference t)
{
	for (var x = t; x != null; x = x.DeclaringType) if (x.Name.Contains('<')) return true;
	return false;
}

static string Norm(string s) => Regex.Replace(s, @"(<[^>]*>[a-zA-Z_]*?)__?[0-9A-Fa-f_]*", "$1").Replace("<>9__", "<>9").Replace("CS$<>", "<>");

static List<string> Sequence(MethodDefinition m)
{
	var result = new List<string>();
	if (!m.HasBody) return result;
	var body = m.Body;
	body.SimplifyMacros();
	foreach (var i in body.Instructions)
	{
		if (i.OpCode.Code == Code.Nop) continue;
		result.Add(i.OpCode.Name.Replace(".s", "") + " " + Operand(i, body));
	}
	return result;
}

static string Operand(Instruction i, MethodBody body) => i.Operand switch
{
	null => "",
	Instruction t => "L" + body.Instructions.IndexOf(t),
	Instruction[] ts => string.Join(",", ts.Select(t => "L" + body.Instructions.IndexOf(t))),
	VariableDefinition v => "v" + v.Index,
	ParameterDefinition p => "a" + p.Index,
	MemberReference r => Norm(r.FullName),
	float f => f.ToString("R"),
	double d => d.ToString("R"),
	var o => o.ToString(),
};
