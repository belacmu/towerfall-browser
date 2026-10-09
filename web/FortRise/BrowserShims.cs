using System.IO;
using System.Reflection;

namespace TowerFallBrowser;

// Replacements the patched game calls instead of APIs that don't fit the browser
// (see FortRisePatcher.BrowserFixups, which rewrites the calls).
public static class BrowserShims
{
	// What the game is told when it asks SDL for the OS name. It only knows Windows/macOS/Linux,
	// and Linux paths fit the browser's virtual filesystem. FNA itself still sees "Emscripten".
	public static string Platform() => "Linux";

	// Assembly.Location is empty for assemblies bundled with the app; FortRise reads their files
	// with Cecil. BrowserHost.MountAssemblies exposes every bundled assembly at /bin/<name>.dll.
	public static string AssemblyLocation(Assembly assembly)
	{
		string location = assembly.Location;
		if (!string.IsNullOrEmpty(location)) return location;
		string bundled = "/bin/" + assembly.GetName().Name + ".dll";
		return File.Exists(bundled) ? bundled : location;
	}
}
