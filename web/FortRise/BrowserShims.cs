using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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

	// FortRise's ModuleManager.LoadMods walks the mod list backwards and removes entries as it
	// loads them, but loading a mod also loads the mods that were waiting for it, which removes
	// them from the list too: the walk then sees shifted entries, loads a mod a second time (which
	// throws, e.g. "TFModFortRiseArcher.dll not found") or drops one. That only happens when a
	// waiting mod loads late, which a missing optional dependency causes (LoaderAI's dependency
	// Archer optionally wants Power), and depends on the order the folders are listed in, which
	// the browser's filesystem doesn't define. So hand it the mods in an order where each comes
	// after what it depends on, with optional dependencies that aren't installed left out while
	// they load, so nothing has to wait.
	public static void LoadMods(object manager, IList mods)
	{
		Type metadata = mods.GetType().GetGenericArguments()[0];
		PropertyInfo name = metadata.GetProperty("Name");
		PropertyInfo required = metadata.GetProperty("Dependencies");
		PropertyInfo optional = metadata.GetProperty("OptionalDependencies");
		MethodInfo isLoaded = manager.GetType().GetMethod("CheckDependencyMetadata");
		MethodInfo load = manager.GetType().GetMethod("LoadMods", BindingFlags.NonPublic | BindingFlags.Instance);
		string Name(object mod) => (string)name.GetValue(mod);
		IEnumerable<object> Deps(object mod, PropertyInfo kind) => ((Array)kind.GetValue(mod))?.Cast<object>() ?? Enumerable.Empty<object>();

		var present = new HashSet<string>(mods.Cast<object>().Select(Name));
		var stripped = new List<(object Mod, Array Optional)>();
		foreach (object mod in mods)
		{
			if (optional.GetValue(mod) is not Array all) continue;
			object[] kept = all.Cast<object>().Where(d => present.Contains(Name(d)) || (bool)isLoaded.Invoke(manager, new object[] { d, false })).ToArray();
			if (kept.Length == all.Length) continue;
			Array typed = Array.CreateInstance(metadata, kept.Length);
			Array.Copy(kept, typed, kept.Length);
			optional.SetValue(mod, typed);
			stripped.Add((mod, all));
		}

		// FortRise loads from the end of the list (its priority order), so build the load order
		// from there, taking each mod once everything it depends on in the list is taken.
		var pending = mods.Cast<object>().Reverse().ToList();
		var order = new List<object>();
		var taken = new HashSet<string>();
		while (pending.Count > 0)
		{
			object next = pending.FirstOrDefault(m => Deps(m, required).Concat(Deps(m, optional)).All(d => !present.Contains(Name(d)) || taken.Contains(Name(d)))) ?? pending[0];
			pending.Remove(next);
			order.Add(next);
			taken.Add(Name(next));
		}
		order.Reverse();
		for (int i = 0; i < order.Count; i++) mods[i] = order[i];

		try
		{
			load.Invoke(manager, new object[] { mods });
		}
		catch (TargetInvocationException e) when (e.InnerException != null)
		{
			System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException).Throw();
		}
		finally
		{
			foreach ((object mod, Array all) in stripped) optional.SetValue(mod, all);
		}
	}
}
