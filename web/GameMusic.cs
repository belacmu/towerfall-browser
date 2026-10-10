using System;
using System.Reflection;
using HarmonyLib;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// The page's "Effects" sound setting (main.js): the game's sound effects without its music, for
// playing over music from another app. The game's music plays through the XACT "Music" category,
// whose volume the game sets from Music.MasterVolume (when the music bank loads, from the options);
// while the music is off, postfixes on both hold the category at zero. The player's music volume
// setting is left as it is. (FortRise mods with music systems of their own may not go through it.)
public static class GameMusic
{
	private static volatile bool off;
	private static volatile bool changed;
	private static Type music;
	private static PropertyInfo masterVolume;
	private static FieldInfo audioEngine, audioCategory;
	private static MethodInfo setCategoryVolume;
	private static bool patched;

	// The page turns the music on or off (any thread); the game thread applies it before a frame.
	public static void SetOn(bool on)
	{
		if (off == !on) return;
		off = !on;
		changed = true;
	}

	// Init() calls this after constructing the game, before its first frame (where the game loads
	// its music). If the game isn't as expected, the music just plays.
	public static void Init(Game game)
	{
		try
		{
			const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
			music = game.GetType().Assembly.GetType("Monocle.Music", throwOnError: true);
			masterVolume = music.GetProperty("MasterVolume", any) ?? throw new MissingMemberException("Music.MasterVolume");
			audioEngine = music.GetField("audioEngine", any) ?? throw new MissingMemberException("Music.audioEngine");
			audioCategory = music.GetField("audioCategory", any) ?? throw new MissingMemberException("Music.audioCategory");
			setCategoryVolume = audioCategory.FieldType.GetMethod("SetVolume") ?? throw new MissingMemberException("AudioCategory.SetVolume");
			if (off) Patch();
		}
		catch (Exception e)
		{
			music = null;
			Console.Error.WriteLine($"[music] The game's music can't be turned off on its own: {e.Message}");
		}
	}

	// Game thread, before a frame.
	public static void Update()
	{
		if (!changed || music == null) return;
		changed = false;
		try
		{
			if (off) Patch();
			// The game's own setter puts the category at the player's volume; the postfix, at zero.
			masterVolume.SetValue(null, masterVolume.GetValue(null));
			Console.WriteLine($"[music] {(off ? "off (sound effects only)" : "on")}");
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"[music] Couldn't turn the game's music {(off ? "off" : "on")}: {e}");
		}
	}

	private static void Patch()
	{
		if (patched) return;
		patched = true;
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
		var postfix = new HarmonyMethod(typeof(GameMusic).GetMethod(nameof(HoldSilent), any));
		var harmony = new Harmony("TowerFallBrowser.GameMusic");
		harmony.Patch(masterVolume.GetSetMethod(nonPublic: true), postfix: postfix);
		harmony.Patch(music.GetMethod("Initialize", any), postfix: postfix);
	}

	private static void HoldSilent()
	{
		if (!off || audioEngine.GetValue(null) == null) return;
		// AudioCategory is a struct, but SetVolume acts on its engine, so a boxed copy does.
		setCategoryVolume.Invoke(audioCategory.GetValue(null), new object[] { 0f });
	}
}
