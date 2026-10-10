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

		List<EnabledZip> enabled = File.Exists(Path.Combine(fortriseDir, EnabledFile))
			? JsonSerializer.Deserialize<List<EnabledZip>>(File.ReadAllText(Path.Combine(fortriseDir, EnabledFile)))
			: new List<EnabledZip>();
		// folder name -> sha256 of the zip it came from
		Dictionary<string, string> installed = File.Exists(installedPath)
			? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(installedPath))
			: new Dictionary<string, string>();

		// What each enabled zip should produce.
		var wanted = new Dictionary<string, (string Zip, string Sha, string Prefix)>();
		foreach (EnabledZip e in enabled)
		{
			string zipPath = Path.Combine(fortriseDir, e.zip);
			if (!File.Exists(zipPath))
			{
				log.LogWarning("Enabled mod zip {Zip} is missing; skipping it.", e.zip);
				continue;
			}
			using ZipArchive archive = ZipFile.OpenRead(zipPath);
			foreach ((string folder, string prefix) in ModsIn(archive))
			{
				wanted[folder] = (zipPath, e.sha256, prefix);
			}
		}

		// Remove mods we installed that are no longer enabled (or came from a different zip).
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
			if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
			using ZipArchive archive = ZipFile.OpenRead(w.Zip);
			foreach (ZipArchiveEntry entry in archive.Entries)
			{
				if (!entry.FullName.StartsWith(w.Prefix, StringComparison.Ordinal) || entry.FullName.EndsWith('/')) continue;
				string relative = entry.FullName[w.Prefix.Length..];
				// Native libraries can't load in the browser (the ones mods need are linked in).
				if (relative.StartsWith("Unmanaged/", StringComparison.OrdinalIgnoreCase)) continue;
				string dest = Path.GetFullPath(Path.Combine(target, relative));
				if (!dest.StartsWith(Path.GetFullPath(target) + "/", StringComparison.Ordinal)) continue; // zip-slip
				Directory.CreateDirectory(Path.GetDirectoryName(dest));
				entry.ExtractToFile(dest, overwrite: true);
			}
			installed[folder] = w.Sha;
			log.LogInformation("Installed mod {Folder}.", folder);
		}

		File.WriteAllText(installedPath, JsonSerializer.Serialize(installed));
		StateSpeedups.Install(modsDir, log);
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
