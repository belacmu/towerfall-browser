// Usage: AnyCpu <assembly> [dir to resolve references from]...
// Rewrites the assembly in place as AnyCPU, IL-only.
using Mono.Cecil;

string path = args[0];
var resolver = new DefaultAssemblyResolver();
foreach (string dir in args.Skip(1)) resolver.AddSearchDirectory(dir);
resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
var bytes = new MemoryStream(File.ReadAllBytes(path));
using (var module = ModuleDefinition.ReadModule(bytes, new ReaderParameters { AssemblyResolver = resolver }))
{
	if ((module.Attributes & ModuleAttributes.ILOnly) == 0)
	{
		throw new Exception($"{path} contains native code; it can't be made AnyCPU.");
	}
	module.Architecture = TargetArchitecture.I386;
	module.Attributes = ModuleAttributes.ILOnly;
	module.Write(path);
}
Console.WriteLine($"{Path.GetFileName(path)}: AnyCPU");
