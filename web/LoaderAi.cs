using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// LoaderAI (the loader behind the AIJimmy and AINova mods) sets up computer players from the
// keyboard: every slot without a controller becomes an AI slot, and in archer select each slot's own
// keys (A/Q for P1, Z/S for P2 ... on AZERTY, numpad 1-8 to join) switch it between the AI types
// and join it. A phone has none of those keys, so the page picks the opponents instead
// (SetOpponents): in versus archer select, each chosen slot gets that type through LoaderAI's API
// and joins with a random archer, the way the slot's join key would; a slot set back to none leaves
// again. The keyboard still works as LoaderAI intends.
//
// Also: when the game reassigns the players' inputs (a controller plugged in, or the on-screen
// controls turned on or off), LoaderAI's AI slots would come back empty and it would keep giving
// P1 the input it saved at launch; Resync puts its state back in line with the new inputs.
public static class LoaderAi
{
	private const string Human = "HUMAN";
	private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;

	private static Game game;
	private static Type module, rollcall, aiInput;
	private static object api; // LoaderAI's ApiImplementation
	private static FieldInfo playerInputs, players, characters, altSelect, rollcallMode;
	private static MethodInfo characterTaken, archerDataGet;
	private static PropertyInfo darkWorldDlc;
	private static readonly Random random = new();

	// Per slot: the AI type the page wants there, or null. Set from the page's thread.
	private static volatile string[] wanted = Array.Empty<string>();
	// The archer select elements this joined, and as what.
	private static readonly Dictionary<object, string> joined = new();
	private static int rollcallFrames;

	// After the mods have loaded. Does nothing unless LoaderAI is one of them.
	public static void Init(Game tfGame)
	{
		module = AppDomain.CurrentDomain.GetAssemblies()
			.Select(a => a.GetType("TFModFortRiseLoaderAI.TFModFortRiseLoaderAIModule", throwOnError: false))
			.FirstOrDefault(t => t != null);
		if (module == null) return;
		try
		{
			Assembly tf = tfGame.GetType().Assembly;
			Type tfGameType = tf.GetType("TowerFall.TFGame", throwOnError: true);
			playerInputs = tfGameType.GetField("PlayerInputs", Any);
			players = tfGameType.GetField("Players", Any);
			characters = tfGameType.GetField("Characters", Any);
			altSelect = tfGameType.GetField("AltSelect", Any);
			characterTaken = tfGameType.GetMethod("CharacterTaken", Any);
			rollcall = tf.GetType("TowerFall.RollcallElement", throwOnError: true);
			rollcallMode = tf.GetType("TowerFall.MainMenu", throwOnError: true).GetField("RollcallMode", Any);
			archerDataGet = tf.GetType("TowerFall.ArcherData", throwOnError: true).GetMethods(Any).First(m => m.Name == "Get" && m.GetParameters().Length == 2);
			darkWorldDlc = tf.GetType("TowerFall.GameData", throwOnError: true).GetProperty("DarkWorldDLC", Any);
			aiInput = module.Assembly.GetType("TFModFortRiseLoaderAI.Input", throwOnError: true);
			api = Instance().GetType().GetProperty("LoaderAIModApi", Any).GetValue(Instance());
			new Harmony("TowerFallBrowser.LoaderAi").Patch(
				tf.GetType("TowerFall.PlayerInput", throwOnError: true).GetMethod("AssignInputs", Any),
				postfix: new HarmonyMethod(typeof(LoaderAi).GetMethod(nameof(Resync), Any)) { priority = Priority.Last });
			// The keyboard keys it shows next to AI slots in archer select mean nothing with the
			// on-screen controls.
			new Harmony("TowerFallBrowser.LoaderAi").Patch(
				module.Assembly.GetType("TFModFortRiseLoaderAI.MyRollcallElement", throwOnError: true).GetMethod("Keys_postfix", Any),
				prefix: new HarmonyMethod(typeof(LoaderAi).GetMethod(nameof(KeysPrefix), Any)));
			game = tfGame;
		}
		catch (Exception e)
		{
			game = null;
			Console.Error.WriteLine($"[ai] LoaderAI isn't as expected, so the page can't set up its opponents: {e}");
		}
	}

	// The AI types LoaderAI has (they register once the game has loaded), comma-separated; empty
	// without LoaderAI.
	public static string Types() => game == null ? "" : string.Join(",", (string[])Call(api, "GetAgentTypes"));

	// Per slot (P1 first): an AI type, or empty for none.
	public static void SetOpponents(string[] slots) => wanted = slots.Select(s => string.IsNullOrEmpty(s) ? null : s).ToArray();

	// Each frame, before the game's (game thread).
	public static void Update()
	{
		if (game == null) return;
		object scene = game.GetType().GetProperty("Scene")?.GetValue(game);
		bool versusRollcall = scene?.GetType().FullName == "TowerFall.MainMenu"
			&& scene.GetType().GetProperty("State").GetValue(scene).ToString() == "Rollcall"
			&& rollcallMode.GetValue(null).ToString() == "Versus";
		if (!versusRollcall)
		{
			rollcallFrames = 0;
			joined.Clear();
			return;
		}
		// Once the portraits have come in.
		if (++rollcallFrames < 20) return;
		string[] want = wanted;
		var layers = (IDictionary)scene.GetType().GetProperty("Layers").GetValue(scene);
		var entities = (IList)layers[-1].GetType().GetProperty("Entities").GetValue(layers[-1]);
		foreach (object element in entities.Cast<object>().Where(rollcall.IsInstanceOfType).ToList())
		{
			int slot = (int)Get(element, "playerIndex");
			string type = slot < want.Length ? want[slot] : null;
			object state = Get(element, "state");
			int current = (int)state.GetType().GetProperty("State").GetValue(state);
			joined.TryGetValue(element, out string joinedAs);
			if (joinedAs != null && current == 1 && type != joinedAs)
			{
				Leave(element, slot, state);
			}
			else if (type != null && joinedAs == null && current == 0)
			{
				Join(element, slot, state, type);
			}
			else if (joinedAs != null && current != 1)
			{
				joined.Remove(element);
			}
		}
	}

	private static void Join(object element, int slot, object state, string type)
	{
		if (!SetType(slot, type)) return;
		// A random archer that's free (and unlocked, and installed): what the slot's left/right keys
		// would pick. ChangeSelectionRight skips taken and locked archers, so only call it while
		// there's another one to go to. The Archer mod (which LoaderAI needs) lets players share an
		// archer; still prefer one nobody has.
		int tries = random.Next(20);
		for (int i = 0; i < 60 && (i < tries || !Selectable(element) || Shared(element, slot)); i++)
		{
			if (!(bool)Get(element, "CanChangeSelection")) break;
			Call(element, "ChangeSelectionRight");
		}
		if (!Selectable(element)) return;
		Call(Get(element, "portrait"), "Join", false);
		((bool[])players.GetValue(null))[slot] = true;
		((Array)altSelect.GetValue(null)).SetValue(Get(element, "archerType"), slot);
		state.GetType().GetProperty("State").SetValue(state, 1);
		joined[element] = type;
		Console.WriteLine($"[ai] P{slot + 1}: {type}");
	}

	private static bool Shared(object element, int slot)
	{
		var joinedPlayers = (bool[])players.GetValue(null);
		var archers = (int[])characters.GetValue(null);
		int character = (int)Get(element, "CharacterIndex");
		return Enumerable.Range(0, joinedPlayers.Length).Any(i => i != slot && joinedPlayers[i] && archers[i] == character);
	}

	private static bool Selectable(object element)
	{
		int character = (int)Get(element, "CharacterIndex");
		if ((bool)characterTaken.Invoke(null, new object[] { character })) return false;
		object archer = archerDataGet.Invoke(null, new[] { character, Get(element, "archerType") });
		return !(bool)Get(archer, "RequiresDarkWorldDLC") || (bool)darkWorldDlc.GetValue(null);
	}

	private static void Leave(object element, int slot, object state)
	{
		Call(Get(element, "portrait"), "Leave");
		((bool[])players.GetValue(null))[slot] = false;
		state.GetType().GetProperty("State").SetValue(state, 0);
		joined.Remove(element);
		// Back to the slot's controller, if it has one (as LoaderAI's up key would).
		if ((bool)module.GetMethod("HumanControlExists", Any).Invoke(null, new object[] { slot })) SetType(slot, Human);
		Console.WriteLine($"[ai] P{slot + 1}: none");
	}

	// LoaderAI's archer select switch (MyRollcallElement.NotJoinedUpdate_patch), through its API.
	private static bool SetType(int slot, string type)
	{
		var types = (IDictionary)module.GetField("currentPlayerType", Any).GetValue(null);
		string from = types.Contains(slot) ? (string)types[slot] : null;
		if (from == type) return true;
		object profiles = Instance().GetType().GetProperty("ProfilesModApi", Any).GetValue(Instance());
		var humanNames = (IDictionary)module.Assembly.GetType("TFModFortRiseLoaderAI.MyRollcallElement").GetField("humanPlayerName", Any).GetValue(null);
		if (from == Human && profiles != null) humanNames[slot] = Call(profiles, "GetPlayerName", slot);
		if (!(bool)Call(api, "SetPlayerType", slot, type)) return false;
		if (profiles != null)
		{
			string name = type == Human ? humanNames.Contains(slot) ? (string)humanNames[slot] : null : (string)module.GetMethod("GetAIPlayerName", Any).Invoke(null, new object[] { slot });
			if (name != null) Call(profiles, "SetPlayerName", slot, name);
		}
		return true;
	}

	// PlayerInput.AssignInputs postfix, after the on-screen controls' (TouchGamepad): slots with a
	// controller are human (and that's the input LoaderAI hands back for them), empty ones get an AI
	// again. Before LoaderAI has saved the launch inputs (TFGame.Update), it does this itself.
	private static void Resync()
	{
		try
		{
			if (game == null || !(bool)module.GetField("isHumanPlayerTypeSaved", Any).GetValue(null)) return;
			var inputs = (Array)playerInputs.GetValue(null);
			var types = (IDictionary)module.GetField("currentPlayerType", Any).GetValue(null);
			var saved = (IDictionary)module.GetField("savedHumanPlayerInput", Any).GetValue(null);
			var counts = (int[])module.GetField("nbPlayerType", Any).GetValue(null);
			var agents = (IDictionary)module.GetField("listAgentByType", Any).GetValue(null);
			var order = ((IDictionary)module.GetField("listAgentType", Any).GetValue(null)).Values.Cast<string>().ToList();
			for (int slot = 0; slot < inputs.Length && slot < counts.Length; slot++)
			{
				List<string> available = order.Where(t => agents[t] is Array a && slot < a.Length).ToList();
				object input = inputs.GetValue(slot);
				if (input != null && !aiInput.IsInstanceOfType(input))
				{
					saved[slot] = input;
					types[slot] = Human;
					counts[slot] = 1 + available.Count;
					continue;
				}
				saved.Remove(slot);
				counts[slot] = available.Count;
				string type = types.Contains(slot) && available.Contains((string)types[slot]) ? (string)types[slot] : available.FirstOrDefault();
				types[slot] = type ?? "NONE";
				if (type != null) inputs.SetValue(Call(((Array)agents[type]).GetValue(slot), "getInput"), slot);
			}
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"[ai] Couldn't bring LoaderAI up to date with the new inputs: {e}");
		}
	}

	private static bool KeysPrefix() => !TouchGamepad.Shown;

	// For the "ai" command: what LoaderAI has in each slot.
	public static string Describe()
	{
		if (game == null) return module == null ? "LoaderAI isn't loaded" : "LoaderAI isn't as expected (see the error at launch)";
		var inputs = (Array)playerInputs.GetValue(null);
		var types = (IDictionary)module.GetField("currentPlayerType", Any).GetValue(null);
		string[] want = wanted;
		var slots = Enumerable.Range(0, inputs.Length).Select(i =>
			$"P{i + 1} {(types.Contains(i) ? types[i] : "?")} ({inputs.GetValue(i)?.GetType().Name ?? "-"}){(i < want.Length && want[i] != null ? $" wants {want[i]}" : "")}");
		return $"types {Types()}; {string.Join(", ", slots)}";
	}

	private static object Instance() => module.GetField("Instance", Any).GetValue(null);

	private static object Get(object target, string member)
	{
		Type type = target.GetType();
		FieldInfo field = type.GetField(member, Any);
		return field != null ? field.GetValue(target) : type.GetProperty(member, Any).GetValue(target);
	}

	private static object Call(object target, string method, params object[] args)
	{
		try
		{
			return target.GetType().GetMethods(Any).First(m => m.Name == method && m.GetParameters().Length == args.Length).Invoke(target, args);
		}
		catch (TargetInvocationException e) when (e.InnerException != null)
		{
			System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException).Throw();
			throw;
		}
	}
}
