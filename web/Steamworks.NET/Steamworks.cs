using System;
using System.Collections.Generic;

// Stand-in for Steamworks.NET. Steam is never "running" in the browser, so the game's
// IsSteamRunning() guards skip stats, achievements and Workshop. The remaining members
// exist only so the decompiled code compiles; they return failure/empty values.
namespace Steamworks
{
	public struct AppId_t
	{
		public uint m_AppId;
		public AppId_t(uint value) { m_AppId = value; }
		public static explicit operator AppId_t(uint value) => new AppId_t(value);
		public static explicit operator uint(AppId_t that) => that.m_AppId;
	}

	public struct PublishedFileId_t : IEquatable<PublishedFileId_t>
	{
		public static readonly PublishedFileId_t Invalid = new PublishedFileId_t(0uL);
		public ulong m_PublishedFileId;
		public PublishedFileId_t(ulong value) { m_PublishedFileId = value; }
		public static explicit operator PublishedFileId_t(ulong value) => new PublishedFileId_t(value);
		public static explicit operator ulong(PublishedFileId_t that) => that.m_PublishedFileId;
		public static bool operator ==(PublishedFileId_t x, PublishedFileId_t y) => x.m_PublishedFileId == y.m_PublishedFileId;
		public static bool operator !=(PublishedFileId_t x, PublishedFileId_t y) => !(x == y);
		public bool Equals(PublishedFileId_t other) => m_PublishedFileId == other.m_PublishedFileId;
		public override bool Equals(object other) => other is PublishedFileId_t o && Equals(o);
		public override int GetHashCode() => m_PublishedFileId.GetHashCode();
		public override string ToString() => m_PublishedFileId.ToString();
	}

	public struct SteamAPICall_t
	{
		public static readonly SteamAPICall_t Invalid = new SteamAPICall_t(0uL);
		public ulong m_SteamAPICall;
		public SteamAPICall_t(ulong value) { m_SteamAPICall = value; }
		public static bool operator ==(SteamAPICall_t x, SteamAPICall_t y) => x.m_SteamAPICall == y.m_SteamAPICall;
		public static bool operator !=(SteamAPICall_t x, SteamAPICall_t y) => !(x == y);
		public override bool Equals(object other) => other is SteamAPICall_t o && o == this;
		public override int GetHashCode() => m_SteamAPICall.GetHashCode();
	}

	public struct UGCQueryHandle_t
	{
		public static readonly UGCQueryHandle_t Invalid = new UGCQueryHandle_t(ulong.MaxValue);
		public ulong m_UGCQueryHandle;
		public UGCQueryHandle_t(ulong value) { m_UGCQueryHandle = value; }
	}

	public struct UGCUpdateHandle_t
	{
		public static readonly UGCUpdateHandle_t Invalid = new UGCUpdateHandle_t(ulong.MaxValue);
		public ulong m_UGCUpdateHandle;
		public UGCUpdateHandle_t(ulong value) { m_UGCUpdateHandle = value; }
	}

	public enum EResult
	{
		k_EResultOK = 1,
		k_EResultFail = 2,
		k_EResultFileNotFound = 9
	}

	public enum EWorkshopVote
	{
		k_EWorkshopVoteUnvoted,
		k_EWorkshopVoteFor,
		k_EWorkshopVoteAgainst,
		k_EWorkshopVoteLater
	}

	public enum EWorkshopFileAction
	{
		k_EWorkshopFileActionPlayed,
		k_EWorkshopFileActionCompleted
	}

	public enum EWorkshopFileType
	{
		k_EWorkshopFileTypeFirst = 0,
		k_EWorkshopFileTypeCommunity = 0
	}

	public enum ERemoteStoragePublishedFileVisibility
	{
		k_ERemoteStoragePublishedFileVisibilityPublic,
		k_ERemoteStoragePublishedFileVisibilityFriendsOnly,
		k_ERemoteStoragePublishedFileVisibilityPrivate
	}

	public enum EUGCQuery
	{
		k_EUGCQuery_RankedByVote,
		k_EUGCQuery_RankedByPublicationDate,
		k_EUGCQuery_AcceptedForGameRankedByAcceptanceDate,
		k_EUGCQuery_RankedByTrend
	}

	public enum EUGCMatchingUGCType
	{
		k_EUGCMatchingUGCType_Items = 0,
		k_EUGCMatchingUGCType_UsableInGame = 10
	}

	public enum EOverlayToStoreFlag
	{
		k_EOverlayToStoreFlag_None,
		k_EOverlayToStoreFlag_AddToCart,
		k_EOverlayToStoreFlag_AddToCartAndShow
	}

	[Flags]
	public enum EItemState : uint
	{
		k_EItemStateNone = 0,
		k_EItemStateSubscribed = 1,
		k_EItemStateLegacyItem = 2,
		k_EItemStateInstalled = 4,
		k_EItemStateNeedsUpdate = 8,
		k_EItemStateDownloading = 16,
		k_EItemStateDownloadPending = 32
	}

	public struct RemoteStorageUserVoteDetails_t
	{
		public EResult m_eResult;
		public PublishedFileId_t m_nPublishedFileId;
		public EWorkshopVote m_eVote;
	}

	public struct DownloadItemResult_t
	{
		public AppId_t m_unAppID;
		public PublishedFileId_t m_nPublishedFileId;
		public EResult m_eResult;
	}

	public struct SteamUGCQueryCompleted_t
	{
		public UGCQueryHandle_t m_handle;
		public EResult m_eResult;
		public uint m_unNumResultsReturned;
		public uint m_unTotalMatchingResults;
		public bool m_bCachedData;
	}

	public struct SteamUGCDetails_t
	{
		public PublishedFileId_t m_nPublishedFileId;
		public EResult m_eResult;
	}

	public struct CreateItemResult_t
	{
		public EResult m_eResult;
		public PublishedFileId_t m_nPublishedFileId;
		public bool m_bUserNeedsToAcceptWorkshopLegalAgreement;
	}

	public struct SubmitItemUpdateResult_t
	{
		public EResult m_eResult;
		public bool m_bUserNeedsToAcceptWorkshopLegalAgreement;
		public PublishedFileId_t m_nPublishedFileId;
	}

	public sealed class Callback<T>
	{
		public delegate void DispatchDelegate(T param);
		public static Callback<T> Create(DispatchDelegate func) => new Callback<T>();
		public void Unregister() { }
		public void Dispose() { }
	}

	public sealed class CallResult<T>
	{
		public delegate void APIDispatchDelegate(T param, bool bIOFailure);
		public static CallResult<T> Create(APIDispatchDelegate func = null) => new CallResult<T>();
		public void Set(SteamAPICall_t hAPICall, APIDispatchDelegate func = null) { }
		public bool IsActive() => false;
		public void Cancel() { }
		public void Dispose() { }
	}

	public static class SteamAPI
	{
		public static bool RestartAppIfNecessary(AppId_t unOwnAppID) => false;
		public static bool Init() => false;
		public static bool IsSteamRunning() => false;
		public static void RunCallbacks() { }
		public static void Shutdown() { }
	}

	public static class SteamApps
	{
		public static bool BIsDlcInstalled(AppId_t appID) => false;
	}

	public static class SteamUtils
	{
		public static bool IsOverlayEnabled() => false;
	}

	public static class SteamFriends
	{
		public static void ActivateGameOverlayToStore(AppId_t nAppID, EOverlayToStoreFlag eFlag) { }
		public static void ActivateGameOverlayToWebPage(string pchURL) { }
	}

	public static class SteamUserStats
	{
		public static bool RequestCurrentStats() => false;
		public static SteamAPICall_t RequestGlobalStats(int nHistoryDays) => SteamAPICall_t.Invalid;
		public static bool GetStat(string pchName, out int pData) { pData = 0; return false; }
		public static bool GetStat(string pchName, out float pData) { pData = 0; return false; }
		public static bool SetStat(string pchName, int nData) => false;
		public static bool SetStat(string pchName, float fData) => false;
		public static bool GetGlobalStat(string pchStatName, out long pData) { pData = 0; return false; }
		public static bool GetGlobalStat(string pchStatName, out double pData) { pData = 0; return false; }
		public static bool SetAchievement(string pchName) => false;
		public static bool StoreStats() => false;
		public static bool ResetAllStats(bool bAchievementsToo) => false;
	}

	public static class SteamRemoteStorage
	{
		public static SteamAPICall_t GetUserPublishedItemVoteDetails(PublishedFileId_t nPublishedFileId) => SteamAPICall_t.Invalid;
		public static SteamAPICall_t UpdateUserPublishedItemVote(PublishedFileId_t nPublishedFileId, bool bVoteUp) => SteamAPICall_t.Invalid;
		public static SteamAPICall_t SetUserPublishedFileAction(PublishedFileId_t unPublishedFileId, EWorkshopFileAction eAction) => SteamAPICall_t.Invalid;
	}

	public static class SteamUGC
	{
		public static uint GetItemState(PublishedFileId_t nPublishedFileID) => 0;
		public static SteamAPICall_t SubscribeItem(PublishedFileId_t nPublishedFileID) => SteamAPICall_t.Invalid;
		public static uint GetNumSubscribedItems() => 0;
		public static uint GetSubscribedItems(PublishedFileId_t[] pvecPublishedFileID, uint cMaxEntries) => 0;
		public static bool GetItemInstallInfo(PublishedFileId_t nPublishedFileID, out ulong punSizeOnDisk, out string pchFolder, uint cchFolderSize, out uint punTimeStamp)
		{
			punSizeOnDisk = 0;
			pchFolder = null;
			punTimeStamp = 0;
			return false;
		}
		public static bool DownloadItem(PublishedFileId_t nPublishedFileID, bool bHighPriority) => false;
		public static UGCQueryHandle_t CreateQueryAllUGCRequest(EUGCQuery eQueryType, EUGCMatchingUGCType eMatchingeMatchingUGCTypeFileType, AppId_t nCreatorAppID, AppId_t nConsumerAppID, uint unPage) => UGCQueryHandle_t.Invalid;
		public static bool AddRequiredTag(UGCQueryHandle_t handle, string pTagName) => false;
		public static bool SetRankedByTrendDays(UGCQueryHandle_t handle, uint unDays) => false;
		public static SteamAPICall_t SendQueryUGCRequest(UGCQueryHandle_t handle) => SteamAPICall_t.Invalid;
		public static bool ReleaseQueryUGCRequest(UGCQueryHandle_t handle) => false;
		public static bool GetQueryUGCResult(UGCQueryHandle_t handle, uint index, out SteamUGCDetails_t pDetails) { pDetails = default; return false; }
		public static SteamAPICall_t CreateItem(AppId_t nConsumerAppId, EWorkshopFileType eFileType) => SteamAPICall_t.Invalid;
		public static UGCUpdateHandle_t StartItemUpdate(AppId_t nConsumerAppId, PublishedFileId_t nPublishedFileID) => UGCUpdateHandle_t.Invalid;
		public static bool SetItemContent(UGCUpdateHandle_t handle, string pszContentFolder) => false;
		public static bool SetItemPreview(UGCUpdateHandle_t handle, string pszPreviewFile) => false;
		public static bool SetItemTitle(UGCUpdateHandle_t handle, string pchTitle) => false;
		public static bool SetItemDescription(UGCUpdateHandle_t handle, string pchDescription) => false;
		public static bool SetItemVisibility(UGCUpdateHandle_t handle, ERemoteStoragePublishedFileVisibility eVisibility) => false;
		public static bool SetItemTags(UGCUpdateHandle_t updateHandle, IList<string> pTags) => false;
		public static SteamAPICall_t SubmitItemUpdate(UGCUpdateHandle_t handle, string pchChangeNote) => SteamAPICall_t.Invalid;
	}
}
