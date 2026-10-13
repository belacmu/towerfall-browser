using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Xml;
using HarmonyLib;

namespace TowerFallBrowser;

// XmlElement/XmlDocument.GetElementsByTagName return a live list, which subscribes to the document's
// change events and only unsubscribes when the document changes. The game reads its sprite XML through
// it for every sprite it creates (SpriteData.GetSpriteInt and the like) and never changes that XML, so
// the subscriptions pile up for the whole session: each new one copies the whole subscriber list, and
// none is ever freed. Online play re-creates entities on every rollback (TF.State rebuilds the miasma,
// 13 sprites, on each restore), so after a few minutes one sprite cost ~0.4 ms and 0.8 MB, getting worse.
// The game only loops over the result straight away, so a snapshot of the same elements, in the same
// order, behaves the same (and keeps the game state identical to other players').
public static class XmlSnapshotLists
{
	public static void Install()
	{
		var harmony = new Harmony("TowerFallBrowser.XmlSnapshotLists");
		var prefix = new HarmonyMethod(typeof(XmlSnapshotLists).GetMethod(nameof(GetElementsByTagName), BindingFlags.NonPublic | BindingFlags.Static));
		harmony.Patch(typeof(XmlElement).GetMethod(nameof(XmlElement.GetElementsByTagName), new[] { typeof(string) }), prefix: prefix);
		harmony.Patch(typeof(XmlDocument).GetMethod(nameof(XmlDocument.GetElementsByTagName), new[] { typeof(string) }), prefix: prefix);
	}

	private static bool GetElementsByTagName(XmlNode __instance, string name, ref XmlNodeList __result)
	{
		var found = new List<XmlNode>();
		Collect(__instance, name, found);
		__result = new Snapshot(found);
		return false;
	}

	// As the live list matches: every element below the node (not the node itself), in document order,
	// whose qualified name is `name` ("*" for all).
	private static void Collect(XmlNode node, string name, List<XmlNode> found)
	{
		for (XmlNode child = node.FirstChild; child != null; child = child.NextSibling)
		{
			if (child is XmlElement && (name == "*" || child.Name == name))
			{
				found.Add(child);
			}
			Collect(child, name, found);
		}
	}

	private sealed class Snapshot : XmlNodeList
	{
		private readonly List<XmlNode> nodes;

		public Snapshot(List<XmlNode> nodes) => this.nodes = nodes;

		public override int Count => nodes.Count;

		public override XmlNode Item(int index) => (uint)index < (uint)nodes.Count ? nodes[index] : null;

		public override IEnumerator GetEnumerator() => nodes.GetEnumerator();
	}
}
