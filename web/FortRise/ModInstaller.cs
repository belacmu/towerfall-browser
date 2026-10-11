using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace TowerFallBrowser;

// Installs the mods the player enabled on the page into FortRise's Mods/ folder, the way a careful
// player would by hand: each mod extracted into its own folder (FortRise only reads zips that have
// meta.json at their root, and many mod zips wrap everything in a top-level folder; zips may also
// hold several mods). The page downloads the zips to ModZips/ and lists the enabled ones in
// mods.json; folders this installer created are tracked so disabled mods are removed again without
// touching anything else in Mods/.
public static class ModInstaller
{
	private const string EnabledFile = "mods.json";
	private const string InstalledFile = "browser-installed.json";

	private sealed record EnabledZip(string zip, string sha256);

	public static void Apply(string fortriseDir, ILogger log)
	{
		string modsDir = Path.Combine(fortriseDir, "Mods");
		Directory.CreateDirectory(modsDir);
		string installedPath = Path.Combine(modsDir, InstalledFile);

		List<EnabledZip> enabled = ReadJson<List<EnabledZip>>(Path.Combine(fortriseDir, EnabledFile), log) ?? new();
		// folder name -> sha256 of the zip it came from, or Partial while it's being extracted
		Dictionary<string, string> installed = ReadJson<Dictionary<string, string>>(installedPath, log) ?? new();
		void Save() => File.WriteAllText(installedPath, JsonSerializer.Serialize(installed));

		// What each enabled zip should produce. A zip that can't be read is left out (with a
		// warning), not the end of every mod: it stays enabled on the page until it's removed there.
		var wanted = new Dictionary<string, (string Zip, string Sha, string Prefix)>();
		foreach (EnabledZip e in enabled)
		{
			string zipPath = Path.Combine(fortriseDir, e.zip);
			if (!File.Exists(zipPath))
			{
				log.LogWarning("Enabled mod zip {Zip} is missing; skipping it.", e.zip);
				continue;
			}
			try
			{
				using ZipArchive archive = ZipFile.OpenRead(zipPath);
				foreach ((string folder, string prefix) in ModsIn(archive))
				{
					if (wanted.TryGetValue(folder, out var other) && other.Sha != e.sha256)
					{
						log.LogWarning("Two enabled zips have a mod called {Folder}; using the one in {Zip}.", folder, e.zip);
					}
					wanted[folder] = (zipPath, e.sha256, prefix);
				}
			}
			catch (Exception ex) when (ex is InvalidDataException or IOException)
			{
				log.LogWarning("Mod zip {Zip} can't be read ({Error}); skipping it.", e.zip, ex.Message);
			}
		}

		// Remove mods we installed that are no longer enabled, came from a different zip, or were
		// only partly extracted (the page was closed, or storage ran out, during an install).
		foreach ((string folder, string sha) in installed.ToList())
		{
			if (!wanted.TryGetValue(folder, out var w) || w.Sha != sha)
			{
				string path = Path.Combine(modsDir, folder);
				if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
				installed.Remove(folder);
				log.LogInformation("Removed mod {Folder}.", folder);
			}
		}
		Save();

		foreach ((string folder, var w) in wanted)
		{
			if (installed.TryGetValue(folder, out string sha) && sha == w.Sha && Directory.Exists(Path.Combine(modsDir, folder)))
			{
				continue;
			}
			string target = Path.Combine(modsDir, folder);
			if (Directory.Exists(target) && !installed.ContainsKey(folder))
			{
				log.LogWarning("Mods/{Folder} already exists and wasn't installed by the page; leaving it alone.", folder);
				continue;
			}
			// Claimed before extracting, so a half-extracted folder is still known to be ours.
			installed[folder] = Partial;
			Save();
			try
			{
				if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
				using ZipArchive archive = ZipFile.OpenRead(w.Zip);
				foreach (ZipArchiveEntry entry in archive.Entries)
				{
					// Zips made on Windows can use backslashes (ModsIn reads them the same way).
					string name = entry.FullName.Replace('\\', '/');
					if (!name.StartsWith(w.Prefix, StringComparison.Ordinal) || name.EndsWith('/')) continue;
					string relative = name[w.Prefix.Length..];
					// Native libraries can't load in the browser (the ones mods need are linked in).
					if (relative.StartsWith("Unmanaged/", StringComparison.OrdinalIgnoreCase)) continue;
					string dest = Path.GetFullPath(Path.Combine(target, relative));
					if (!dest.StartsWith(Path.GetFullPath(target) + "/", StringComparison.Ordinal)) continue; // zip-slip
					Directory.CreateDirectory(Path.GetDirectoryName(dest));
					entry.ExtractToFile(dest, overwrite: true);
				}
				installed[folder] = w.Sha;
				Save();
				log.LogInformation("Installed mod {Folder}.", folder);
			}
			catch (Exception ex) when (ex is InvalidDataException or IOException or UnauthorizedAccessException)
			{
				log.LogError("Couldn't install mod {Folder} ({Error}); starting without it.", folder, ex.Message);
				try
				{
					if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
					installed.Remove(folder);
					Save();
				}
				catch (Exception cleanup)
				{
					log.LogWarning("Couldn't clean up Mods/{Folder} ({Error}); the next start tries again.", folder, cleanup.Message);
				}
			}
		}

		StateSpeedups.Install(modsDir, log);
	}

	private const string Partial = "partial";

	// A JSON file this reads back, or null if it's missing or unreadable (a crash while writing it).
	private static T ReadJson<T>(string path, ILogger log) where T : class
	{
		if (!File.Exists(path)) return null;
		try
		{
			return JsonSerializer.Deserialize<T>(File.ReadAllText(path));
		}
		catch (JsonException e)
		{
			log.LogWarning("{File} is unreadable ({Error}); starting it over.", Path.GetFileName(path), e.Message);
			return null;
		}
	}

	// The mods inside a zip: each folder (or the root) holding a meta.json, at most two levels deep,
	// keyed by the folder name to install them under.
	private static IEnumerable<(string Folder, string Prefix)> ModsIn(ZipArchive archive)
	{
		foreach (ZipArchiveEntry entry in archive.Entries)
		{
			string name = entry.FullName.Replace('\\', '/');
			if (!name.EndsWith("meta.json", StringComparison.OrdinalIgnoreCase) || name.Count(c => c == '/') > 2) continue;
			string prefix = name[..^"meta.json".Length];
			string folder;
			try
			{
				using var reader = new StreamReader(entry.Open());
				using JsonDocument meta = JsonDocument.Parse(reader.ReadToEnd(), new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
				folder = meta.RootElement.EnumerateObject()
					.FirstOrDefault(p => p.Name.Equals("name", StringComparison.OrdinalIgnoreCase)).Value.GetString();
			}
			catch
			{
				continue;
			}
			if (string.IsNullOrWhiteSpace(folder)) continue;
			folder = string.Concat(folder.Split(Path.GetInvalidFileNameChars())).Replace("/", "_");
			yield return (folder, prefix);
		}
	}
}
