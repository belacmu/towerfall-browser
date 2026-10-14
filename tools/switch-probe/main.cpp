/*
 * TowerFall Switch — cross-play probe (exlaunch module)
 * -----------------------------------------------------
 * Steps 2–3 of the Switch × browser rollback feasibility plan
 * (towerfall-browser: docs/SWITCH-CROSSPLAY.md). Its own exlaunch checkout
 * (copied from ~/Code/tf3-exlaunch's build setup).
 *
 * At boot:
 *   - 2c math check: the SDK's sin/cos/atan2/pow (what the game's Math.* calls) and musl's pow
 *     (mathlib/, the browser's) on the same inputs as the browser's "mathtest"; logs hashes.
 *   - Fixes for cross-play: the game's pow import -> musl's pow; Math.Round(double) ->
 *     ties-to-even (BRUTE's is floor(x + 0.5); .NET rounds half to even).
 * Determinism test (step 3):
 *   - A script on the SD card, sdmc:/xplay/script.txt, drives player 1. Each line holds until the
 *     next:
 *       "M <poll> <buttons hex> <stick x> <stick y>": menus, as Pro Controller input (polls
 *       counted from boot). Controller polls aren't in step with game frames, so this is only
 *       for getting into the level.
 *       "T <frame> <flags hex> <moveX> <moveY>": in the level, as the game's own InputState, written
 *       in Player.Update right after PlayerInput.GetState() (frame-exact, platform-neutral; the
 *       browser feeds the same). Flags: 1 jump, 2 shoot, 4 dodge, 8 alt shoot, 0x10 arrows (held;
 *       "pressed" = held now but not last frame). AimAxis = the move direction (diagonals
 *       0.70710677). Frame 0 is the first Player.Update after the player's first NormalUpdate.
 *   - Each of those frames logs player 1's position and speed (float bits) as the frame starts:
 *     "[xplay] T <frame> <x> <y> <sx> <sy>".
 *
 * Output: the guest log ("[xplay] ..." lines in Ryujinx's log; read it with grep -a).
 * Offsets: TowerFall v1.4.1.6 main, flat-image (module-base-relative).
 */

#include "lib.hpp"
#include "loggers.hpp"
#include "nn/fs.hpp"
#include "patch/code_patcher.hpp"
#include <lib/util/sys/modules.hpp>
#include <common.hpp>

#include <cstdint>
#include <cstring>
#include <cstdlib>

/* musl's pow as the browser runs it (source/program/mathlib: Emscripten's musl, no FMA path,
 * -ffp-contract=off). The SDK's pow differs from the browser's; this is the fix. */
extern "C" double xplay_musl_pow(double, double);

namespace xplay {

namespace off {
    constexpr uintptr_t PowImportSlot        = 0x47225b0;
    constexpr uintptr_t NpadFullKeyStateSlot = 0x4722830; /* nn::hid::GetNpadState(NpadFullKeyState*, const uint&) */
    constexpr uintptr_t MathRoundDouble      = 0xaca0;    /* fmov d1,#0.5; fadd d0,d0,d1; frintm d0,d0; ret */
    constexpr uintptr_t Player_NormalUpdate  = 0xae81d0;  /* int (Player*) */
    constexpr uintptr_t EngineUpdate_FixedStepBranch = 0x92d15c; /* after `bl Game.get_IsFixedTimeStep` */
    constexpr uint32_t  kFixedStepBranchInsn = 0x360001c0;      /* tbz w0, #0, +0x38 */
    /* Player.Update (+0xaef280), right after `input = PlayerInputs[i].GetState()` (slot 0x20,
     * InputState returned on the stack) has loaded the 28 bytes into x8/x9/x10/w11 and before they're
     * stored to Player.input (+0x148): `str w11, [x19, #0x160]`. x19 = the Player. */
    constexpr uintptr_t Player_Update_InputStore = 0xaef934;
    /* TFGame.Update(GameTime): the input update, then Engine.Update (+0x92d0b0). */
    constexpr uintptr_t TFGame_Update = 0xb75c60;
    constexpr uint32_t  kTFGameUpdateInsn = 0xa9be4ff4; /* stp x20, x19, [sp, #-0x20]! */
    /* The graphics layer's per-frame buffer allocator: x0 = a native ring of transient GPU buffers
     * (0x5600 bytes, inside a managed object) that tracks GPU frames (+0x55b8); rolling one back
     * trips an assertion. */
    constexpr uintptr_t GfxRingAlloc = 0x204d0;
    constexpr uint32_t  kInputStoreInsn = 0xb901626b;
}
namespace fld {
    constexpr uint32_t Entity_PositionX = 0x14, Entity_PositionY = 0x18;
    constexpr uint32_t Player_PlayerIndex = 0xe4;
    constexpr uint32_t Player_SpeedX = 0x2c8, Player_SpeedY = 0x2cc;
}

static uintptr_t Base() { return exl::util::GetMainModuleInfo().m_Total.m_Start; }

using Fn1 = double (*)(double);
using Fn2 = double (*)(double, double);

/* ---- 2c: math check ----------------------------------------------------------------------- */

/* xorshift32, the same sequence as Determinism.cs. */
static uint32_t state;
static uint32_t Next() {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
}

/* A float in [lo, hi): what the game passes (float fields widened to double). */
static float Range(float lo, float hi) {
    double t = (double)(Next() % 1000001) / 1000000.0;
    return (float)(lo + t * (hi - lo));
}

struct Hash {
    uint64_t h = 1469598103934665603ull;
    void Mix(double d) {
        uint64_t bits;
        std::memcpy(&bits, &d, 8);
        if (d != d) bits = 0x7FF8000000000000ull; /* one NaN */
        for (int i = 0; i < 8; i++) {
            h ^= (bits >> (8 * i)) & 0xFF;
            h *= 1099511628211ull;
        }
    }
};

/* The address of an exported (defined) function in any loaded module, from its dynamic symbol
 * table. At exl_main time the game's own import slots aren't bound yet (calling through them
 * crashed in rtld's lazy binder), so functions are looked up where they're defined (nnSdk). */
struct Elf64Sym { uint32_t name; uint8_t info, other; uint16_t shndx; uint64_t value, size; };
static uintptr_t FindExport(const char* wanted) {
    for (int i = (int)exl::util::ModuleIndex::Start; i < (int)exl::util::ModuleIndex::End; i++) {
        if (!exl::util::impl::mem_layout::s_ModuleBitset[i]) continue;
        uintptr_t base = exl::util::GetModuleInfo((exl::util::ModuleIndex)i).m_Total.m_Start;
        uint32_t mod0 = *reinterpret_cast<uint32_t*>(base + 4);
        if (std::memcmp(reinterpret_cast<void*>(base + mod0), "MOD0", 4) != 0) continue;
        uintptr_t dyn = base + mod0 + *reinterpret_cast<int32_t*>(base + mod0 + 4);
        uintptr_t symtab = 0, strtab = 0;
        for (auto* d = reinterpret_cast<int64_t*>(dyn); d[0] != 0; d += 2) {
            if (d[0] == 6) symtab = base + d[1];
            if (d[0] == 5) strtab = base + d[1];
        }
        if (!symtab || !strtab || strtab <= symtab) continue;
        /* The string table follows the symbol table in these modules. */
        for (auto* s = reinterpret_cast<Elf64Sym*>(symtab); reinterpret_cast<uintptr_t>(s + 1) <= strtab; s++) {
            if (s->shndx != 0 && s->value != 0 && std::strcmp(reinterpret_cast<const char*>(strtab + s->name), wanted) == 0)
                return base + s->value;
        }
    }
    return 0;
}

static void MathCheck() {
    auto sin_ = reinterpret_cast<Fn1>(FindExport("sin"));
    auto cos_ = reinterpret_cast<Fn1>(FindExport("cos"));
    auto atan2_ = reinterpret_cast<Fn2>(FindExport("atan2"));
    auto pow_ = reinterpret_cast<Fn2>(FindExport("pow"));
    if (!sin_ || !cos_ || !atan2_ || !pow_) {
        Logging.Log("[xplay] math exports not found");
        return;
    }
    uint64_t fpcr;
    asm volatile("mrs %0, fpcr" : "=r"(fpcr));
    Logging.Log("[xplay] FPCR=%#llx (FZ=%d DN=%d RMode=%d)", (unsigned long long)fpcr,
                (int)((fpcr >> 24) & 1), (int)((fpcr >> 25) & 1), (int)((fpcr >> 22) & 3));
    Hash hs, hc, ha, hp, hm;
    state = 2463534242u;
    for (int i = 0; i < 100000; i++) {
        float angle = Range(-10.0f, 10.0f);
        hs.Mix(sin_((double)angle));
        hc.Mix(cos_((double)angle));
        float y = Range(-500.0f, 500.0f), x = Range(-500.0f, 500.0f);
        ha.Mix(atan2_((double)y, (double)x));
        float b = Range(0.0f, 2.0f), e = Range(0.0f, 3.0f);
        hp.Mix(pow_((double)b, (double)e));
        hp.Mix(pow_(0.9800000190734863, (double)e)); /* Arrow.ArrowUpdate's drag */
        hm.Mix(xplay_musl_pow((double)b, (double)e));
        hm.Mix(xplay_musl_pow(0.9800000190734863, (double)e));
    }
    Logging.Log("[xplay] mathtest sin %016llx cos %016llx atan2 %016llx pow %016llx musl-pow %016llx",
                (unsigned long long)hs.h, (unsigned long long)hc.h, (unsigned long long)ha.h,
                (unsigned long long)hp.h, (unsigned long long)hm.h);
}

/* ---- Cross-play fixes ------------------------------------------------------------------------ */

static void ApplyFixes() {
    /* pow: lazily bound import slots are ordinary writable data (CodePatcher's code mirror doesn't
     * cover them). Written before the game's first call, so lazy binding never replaces it. */
    *reinterpret_cast<volatile uintptr_t*>(Base() + off::PowImportSlot) = reinterpret_cast<uintptr_t>(&xplay_musl_pow);

    /* Math.Round(double): frintn (ties to even), like .NET. */
    auto* code = reinterpret_cast<uint32_t*>(Base() + off::MathRoundDouble);
    if (code[0] == 0x1e6c1001 && code[1] == 0x1e612800 && code[2] == 0x1e654000 && code[3] == 0xd65f03c0) {
        exl::patch::CodePatcher p(off::MathRoundDouble);
        p.Write<uint32_t>(0x1e644000); /* frintn d0, d0 */
        p.Write<uint32_t>(0xd65f03c0); /* ret */
        Logging.Log("[xplay] fixes: pow -> musl, Math.Round -> ties to even");
    } else {
        Logging.Log("[xplay] Math.Round isn't as expected (%08x %08x): NOT patched", code[0], code[1]);
    }

    /* Fixed timestep: Engine.Update takes the IsFixedTimeStep branch always (TimeMult = TimeRate,
     * DeltaTime = TimeRate/60) instead of measuring real frame time, which jitters. The browser does
     * the same. `tbz w0, #0, <variable branch>` after the IsFixedTimeStep call -> nop. */
    auto* branch = reinterpret_cast<uint32_t*>(Base() + off::EngineUpdate_FixedStepBranch);
    if (*branch == off::kFixedStepBranchInsn) {
        exl::patch::CodePatcher p(off::EngineUpdate_FixedStepBranch);
        p.Write<uint32_t>(0xd503201f); /* nop */
        Logging.Log("[xplay] fixes: fixed timestep");
    } else {
        Logging.Log("[xplay] Engine.Update isn't as expected (%08x): fixed timestep NOT applied", *branch);
    }
}

/* ---- Determinism test: scripted input, per-frame state -------------------------------------- */

struct Step { char phase; int at; uint64_t buttons; int32_t x, y; };
static Step g_steps[512];
static int g_stepCount = 0;
static bool g_scriptLoaded = false;

static void LoadScript() {
    g_scriptLoaded = true;
    if (nn::fs::MountSdCardForDebug("sd") != 0) {
        Logging.Log("[xplay] script: can't mount the SD card");
        return;
    }
    nn::fs::FileHandle h;
    if (nn::fs::OpenFile(&h, "sd:/xplay/script.txt", nn::fs::OpenMode_Read) != 0) {
        Logging.Log("[xplay] script: no sd:/xplay/script.txt");
        return;
    }
    long size = 0;
    nn::fs::GetFileSize(&size, h);
    static char buf[32768];
    if (size > (long)sizeof(buf) - 1) size = sizeof(buf) - 1;
    nn::fs::ReadFile(h, 0, buf, size);
    nn::fs::CloseFile(h);
    buf[size] = 0;
    for (char* line = buf; line && *line && g_stepCount < 512;) {
        char* nl = std::strchr(line, '\n');
        if (nl) *nl = 0;
        if (line[0] == 'M' || line[0] == 'T') {
            Step s{};
            s.phase = line[0];
            char* p = line + 1;
            s.at = (int)std::strtol(p, &p, 10);
            s.buttons = std::strtoull(p, &p, 16);
            s.x = (int32_t)std::strtol(p, &p, 10);
            s.y = (int32_t)std::strtol(p, &p, 10);
            g_steps[g_stepCount++] = s;
        }
        line = nl ? nl + 1 : nullptr;
    }
    Logging.Log("[xplay] script: %d steps", g_stepCount);
}

/* The script's input at a point of a phase: the last step at or before it. */
static const Step* StepAt(char phase, int at) {
    const Step* found = nullptr;
    for (int i = 0; i < g_stepCount; i++)
        if (g_steps[i].phase == phase && g_steps[i].at <= at) found = &g_steps[i];
    return found;
}

static void* volatile g_player = nullptr; /* set by the first NormalUpdate */
static int g_polls = 0;                   /* player 1 polls since boot */
static int g_frame = -1;                  /* polls since the player's first NormalUpdate */

HOOK_DEFINE_TRAMPOLINE(NormalUpdateHook) {
    static int Callback(void* self) {
        if (!g_player) {
            g_player = self;
            Logging.Log("[xplay] player under control (first NormalUpdate) at poll %d", g_polls);
            uintptr_t v0 = *reinterpret_cast<uintptr_t*>(self);
            uintptr_t v1 = v0 ? *reinterpret_cast<uintptr_t*>(v0 + 8) : 0;
            if (v1) {
                uintptr_t raw = *reinterpret_cast<uintptr_t*>(v1 + 0x40);
                Logging.Log("[xplay] Player.Update body +%#lx (tag %#lx)", (unsigned long)((raw & 0x7fffffffffffffffULL) - Base()),
                            (unsigned long)(raw >> 59));
            }
        }
        return Orig(self);
    }
};

struct NpadFullKeyState {
    int64_t samplingNumber;
    uint64_t buttons;
    int32_t lx, ly, rx, ry;
    uint32_t attributes;
    uint32_t reserved;
};
using GetFullKeyFn = void (*)(NpadFullKeyState*, const uint32_t&);
static GetFullKeyFn g_getFullKey = nullptr;

static float Field(uint32_t off) { return *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(g_player) + off); }
static uint32_t AsU32(float f) { uint32_t u; std::memcpy(&u, &f, 4); return u; }

static void GetFullKeyHook(NpadFullKeyState* out, const uint32_t& id) {
    g_getFullKey(out, id);
    if (id != 0) return; /* player 1 */
    if (!g_scriptLoaded) LoadScript();
    g_polls++;
    if (!g_player && g_polls % 60 == 0) Logging.Log("[xplay] poll %d", g_polls);
    const Step* s = StepAt('M', g_polls);
    if (s) {
        out->buttons = s->buttons;
        out->lx = s->x;
        out->ly = s->y;
        out->attributes |= 1; /* connected */
    }
}

/* ---- Rollback feasibility, phase 1: a read-only memory census ------------------------------------
 * At frame kCensusFrame of the level (the game thread, frame start): the memory map, then a
 * fingerprint of every 4 KB page of the region holding the player object (where the game's
 * objects live) on two consecutive frames and 60 frames later: how big the state is, and how much
 * of it changes per frame. Reads only. */
constexpr int kCensusFrame = 120;
constexpr size_t kMaxPages = 1u << 20;       /* 4 GB of 4 KB pages */
static uint32_t g_pageHash[kMaxPages];       /* 4 MB */
static uint32_t PageHash(const uint8_t* p) {
    const uint64_t* q = reinterpret_cast<const uint64_t*>(p);
    uint64_t h = 0;
    for (int i = 0; i < 512; i++) h = (h ^ q[i]) * 0x100000001b3ull;
    return (uint32_t)(h ^ (h >> 32));
}

/* Rollback feasibility, phase 1b: Boehm's own list of heap sections (GC_add_to_heap, +0x2857ed0,
 * appends {start, bytes} at GC_arrays + 0x68e0 and counts them in GC_n_heap_sects; both found
 * through pointers the code loads from +0x483b648 and +0x483b6e8). Everything the game allocates
 * is in these sections; with the main module's globals (.data/.bss, Boehm's state included) that is
 * what a rollback snapshot would copy. How big, and how many pages change per frame? Reads only. */
struct MemRange { uintptr_t start, size; };
constexpr int kMaxRanges = 1100;
static MemRange g_ranges[kMaxRanges];
static int g_nRanges = 0, g_nHeap = 0, g_nHeapSections = 0;

/* Boehm's block headers (0x70 bytes: object size, mark bits, free-list links) and the "bottom
 * index" tables that map blocks to them (0x2020 bytes) live outside the heap sections, in 64 KB
 * scratch chunks (GC_install_header, +0x285b680). They change whenever blocks are allocated or
 * split, so a snapshot needs them: walk GC_all_bottom_indices (+0x48e2a38, linked at +0x2000) and
 * add every page holding a table or a header. */
static void AddPage(uintptr_t page) {
    for (int r = 0; r < g_nRanges; r++)
        if (page >= g_ranges[r].start && page < g_ranges[r].start + g_ranges[r].size) return;
    if (g_nRanges && g_ranges[g_nRanges - 1].start + g_ranges[g_nRanges - 1].size == page) { g_ranges[g_nRanges - 1].size += 0x1000; return; }
    if (g_nRanges < kMaxRanges - 1) g_ranges[g_nRanges++] = { page, 0x1000 };
}
static void AddBytes(uintptr_t p, uintptr_t n) {
    for (uintptr_t page = p & ~0xfffUL; page < p + n; page += 0x1000) AddPage(page);
}
static void CollectGcMetadata() {
    int first = g_nRanges, tables = 0, headers = 0;
    for (uintptr_t bi = *reinterpret_cast<uintptr_t*>(Base() + 0x48e2a38); bi; bi = *reinterpret_cast<uintptr_t*>(bi + 0x2000)) {
        AddBytes(bi, 0x2020);
        tables++;
        for (int i = 0; i < 0x400; i++) {
            uintptr_t h = reinterpret_cast<uintptr_t*>(bi)[i];
            if (h > 0x1000) { AddBytes(h, 0x70); headers++; }   /* small values: "go back n blocks" */
        }
        if (tables > 4096) break;
    }
    uintptr_t bytes = 0;
    for (int r = first; r < g_nRanges; r++) bytes += g_ranges[r].size;
    Logging.Log("[xplay] census: GC metadata: %d index tables, %d block headers, in %d ranges, %lu KB", tables, headers,
                g_nRanges - first, (unsigned long)(bytes >> 10));
}

static void CollectRanges() {
    g_nRanges = 0;
    uintptr_t arrays = *reinterpret_cast<uintptr_t*>(Base() + 0x483b648);
    uintptr_t count = **reinterpret_cast<uintptr_t**>(Base() + 0x483b6e8);
    Logging.Log("[xplay] census: GC_arrays %#lx, %lu heap sections", (unsigned long)arrays, (unsigned long)count);
    if (count > 1024) return;
    uintptr_t total = 0, player = reinterpret_cast<uintptr_t>(g_player);
    for (uintptr_t i = 0; i < count; i++) {
        uintptr_t start = *reinterpret_cast<uintptr_t*>(arrays + 0x68e0 + i * 16);
        uintptr_t bytes = *reinterpret_cast<uintptr_t*>(arrays + 0x68e8 + i * 16);
        for (uintptr_t a = start; a < start + bytes && g_nRanges < kMaxRanges - 1;) {
            MemoryInfo mi{}; u32 pi;
            if (R_FAILED(svcQueryMemory(&mi, &pi, a))) break;
            uintptr_t end = mi.addr + mi.size < start + bytes ? mi.addr + mi.size : start + bytes;
            if (mi.perm & Perm_R) g_ranges[g_nRanges++] = { a, end - a };
            else Logging.Log("[xplay] census:   (unreadable: %#lx, %lu KB)", (unsigned long)a, (unsigned long)((end - a) >> 10));
            a = end;
        }
        total += bytes;
        if (i < 12 || (player >= start && player < start + bytes))
            Logging.Log("[xplay] census:   section %lu at %#lx, %lu KB%s", (unsigned long)i, (unsigned long)start,
                        (unsigned long)(bytes >> 10), player >= start && player < start + bytes ? "  <- player" : "");
    }
    g_nHeapSections = g_nRanges;
    CollectGcMetadata();
    g_nHeap = g_nRanges;
    auto& d = exl::util::GetMainModuleInfo().m_Data;
    g_ranges[g_nRanges++] = { d.m_Start, d.m_Size };
    Logging.Log("[xplay] census: GC heap total %lu KB; main module globals %lu KB at %#lx", (unsigned long)(total >> 10),
                (unsigned long)(d.m_Size >> 10), (unsigned long)d.m_Start);
}

/* Fingerprints every page of the ranges; counts pages that differ from the last call, for the heap
 * and for the globals. */
static void ScanRanges(bool compare, size_t* heapChanged, size_t* globalsChanged) {
    size_t k = 0, hc = 0, gc = 0;
    for (int r = 0; r < g_nRanges; r++)
        for (uintptr_t off = 0; off + 0x1000 <= g_ranges[r].size && k < kMaxPages; off += 0x1000, k++) {
            uint32_t h = PageHash(reinterpret_cast<const uint8_t*>(g_ranges[r].start + off));
            if (compare && h != g_pageHash[k]) (r < g_nHeap ? hc : gc)++;
            g_pageHash[k] = h;
        }
    if (heapChanged) *heapChanged = hc;
    if (globalsChanged) *globalsChanged = gc;
}

/* The game's InputState (natural layout: 9 bools, then MoveX, MoveY, AimAxis), in the registers
 * Player.Update is about to store: x8 = bytes 0..7, x9 = 8..15, x10 = 16..23, w11 = 24..27. */
static bool g_prevJump, g_prevShoot, g_prevDodge, g_prevAlt;

HOOK_DEFINE_INLINE(InputStoreHook) {
    static void Callback(exl::hook::InlineCtx* ctx) {
        void* player = reinterpret_cast<void*>(ctx->X[19]);
        if (!g_player || player != g_player) return;
        g_frame++;
        Logging.Log("[xplay] T %d %08x %08x %08x %08x", g_frame,
                    AsU32(Field(fld::Entity_PositionX)), AsU32(Field(fld::Entity_PositionY)),
                    AsU32(Field(fld::Player_SpeedX)), AsU32(Field(fld::Player_SpeedY)));
        const Step* s = StepAt('T', g_frame);
        if (!s) return;
        uint32_t f = (uint32_t)s->buttons;
        bool jump = f & 1, shoot = f & 2, dodge = f & 4, alt = f & 8, arrows = f & 0x10;
        uint8_t b[28] = {};
        b[0] = jump;  b[1] = jump && !g_prevJump;
        b[2] = shoot; b[3] = shoot && !g_prevShoot;
        b[4] = alt;   b[5] = alt && !g_prevAlt;
        b[6] = dodge; b[7] = dodge && !g_prevDodge;
        b[8] = arrows;
        g_prevJump = jump; g_prevShoot = shoot; g_prevDodge = dodge; g_prevAlt = alt;
        int32_t mx = s->x, my = s->y;
        float ax = (float)mx, ay = (float)my;
        if (mx != 0 && my != 0) { ax *= 0.70710677f; ay *= 0.70710677f; }
        std::memcpy(b + 12, &mx, 4);
        std::memcpy(b + 16, &my, 4);
        std::memcpy(b + 20, &ax, 4);
        std::memcpy(b + 24, &ay, 4);
        uint64_t q[3]; uint32_t w;
        std::memcpy(q, b, 24);
        std::memcpy(&w, b + 24, 4);
        ctx->X[8] = q[0]; ctx->X[9] = q[1]; ctx->X[10] = q[2]; ctx->W[11] = w;
    }
};


/* ---- Rollback feasibility, phase 2: save and restore raw memory ------------------------------
 * At the top of TFGame.Update (+0xb75c60, the whole frame: it runs the input update then
 * Engine.Update), with the player's frame counter at a window's start: copy the GC heap sections
 * and the main module's globals. When the window has run, restore them, rewind the script, and run
 * the window again. The "[xplay] T" lines for those frames then appear twice and must match, and
 * every page's fingerprint at the window's end must match the first pass's. Also logs how many
 * pages the window changed (what an incremental snapshot would copy) and how long copies take.
 * The snapshot also covers Boehm's block headers (CollectGcMetadata). Kept as they are, not
 * restored: the graphics layer's buffer slots (GfxRingHook), which point at native buffers that
 * track GPU frames. */
struct Window { int start, length; };
static const Window kWindows[] = { {85, 8}, {198, 8}, {236, 8}, {326, 30}, {476, 8} };
constexpr size_t kSnapMax = 112u << 20;
alignas(0x1000) static uint8_t g_snap[kSnapMax];
static int g_win = 0, g_pass = 0;              /* g_pass: 0 waiting, 1 first run, 2 replay */
static int g_snapSections = 0;
static bool g_snapPrev[4];
static size_t g_rangeBytes = 0;

/* Native engine state inside managed objects, kept as it is when restoring (not game state). */
struct Keep { uintptr_t start, size; };
static Keep g_keep[64];
static int g_nKeep = 0;
alignas(0x1000) static uint8_t g_keepBuf[256u << 10];

static void KeepObject(const char* what, uintptr_t obj, uintptr_t size) {
    for (int i = 0; i < g_nKeep; i++) if (g_keep[i].start == obj) return;
    if (g_nKeep == 64) return;
    g_keep[g_nKeep++] = { obj, size };   /* exact bytes: neighbouring objects are game state */
    Logging.Log("[xplay] rollback: keeping %s at %#lx (%lu bytes) out of restores", what, (unsigned long)obj, (unsigned long)size);
}

static int g_loggedGfx[2];
HOOK_DEFINE_TRAMPOLINE(GfxRingHook) {
    static void* Callback(void* self, void* a, void* b, void* c, void* d, void* e, void* f, void* g) {
        uintptr_t slot = reinterpret_cast<uintptr_t>(self);
        uintptr_t buffer = *reinterpret_cast<uintptr_t*>(slot);
        KeepObject("graphics buffer slot", slot, 8);
        if (!g_loggedGfx[0] && buffer) {
            uintptr_t device = *reinterpret_cast<uintptr_t*>(buffer + 0x58);
            Logging.Log("[xplay] gfx: slot %#lx -> buffer %#lx -> device %#lx", (unsigned long)slot, (unsigned long)buffer, (unsigned long)device);
            if (++g_loggedGfx[1] > 16) g_loggedGfx[0] = true;
        }
        return Orig(self, a, b, c, d, e, f, g);
    }
};

static uintptr_t HeapSectionCount() { return **reinterpret_cast<uintptr_t**>(Base() + 0x483b6e8); }
static double Ms(uint64_t ticks) { return ticks / 19200.0; }

/* Debug: the audio layer's list of active sound instances (static at +0x4724770 -> List: items
 * +0x10, count +0x18; items array: length at [+0x20], elements from [+0x10]). */
static const char* Where(uintptr_t a) {
    for (int r = 0; r < g_nRanges; r++)
        if (a >= g_ranges[r].start && a < g_ranges[r].start + g_ranges[r].size)
            return r < g_nHeapSections ? "GC heap" : r < g_nHeap ? "GC metadata" : "globals";
    return "not snapshotted";
}

static void DumpSoundList(const char* when) {
    uintptr_t list = **reinterpret_cast<uintptr_t**>(Base() + 0x4724770);
    if (!list) { Logging.Log("[xplay] sounds %s: no list", when); return; }
    uintptr_t arr = *reinterpret_cast<uintptr_t*>(list + 0x10);
    int count = *reinterpret_cast<int*>(list + 0x18);
    uintptr_t elems = arr ? *reinterpret_cast<uintptr_t*>(arr + 0x10) : 0;
    Logging.Log("[xplay] sounds %s: list %#lx count %d array %#lx elems %#lx", when, (unsigned long)list, count, (unsigned long)arr, (unsigned long)elems);
    for (int i = 0; i < count && i < 8 && elems; i++) {
        uintptr_t e = reinterpret_cast<uintptr_t*>(elems)[i];
        Logging.Log("[xplay] sounds %s:   [%d] %#lx%s", when, i, (unsigned long)e, e ? (*reinterpret_cast<uint8_t*>(e + 0x10) ? " disposed" : "") : "");
    }
}

static void Save() {
    CollectRanges();
    g_rangeBytes = 0;
    for (int r = 0; r < g_nRanges; r++) g_rangeBytes += g_ranges[r].size;
    if (g_rangeBytes > kSnapMax) { Logging.Log("[xplay] rollback: %lu KB too big", (unsigned long)(g_rangeBytes >> 10)); g_nRanges = 0; return; }
    DumpSoundList("at save");
    for (int i = 0; i < g_nKeep; i++) {
        uintptr_t buffer = *reinterpret_cast<uintptr_t*>(g_keep[i].start);
        uintptr_t device = buffer ? *reinterpret_cast<uintptr_t*>(buffer + 0x58) : 0;
        Logging.Log("[xplay] gfx: slot %#lx (%s) -> buffer %#lx (%s) -> device %#lx (%s)", (unsigned long)g_keep[i].start, Where(g_keep[i].start),
                    (unsigned long)buffer, Where(buffer), (unsigned long)device, Where(device));
    }
    uint64_t t0 = svcGetSystemTick();
    size_t at = 0;
    for (int r = 0; r < g_nRanges; r++) { std::memcpy(g_snap + at, (void*)g_ranges[r].start, g_ranges[r].size); at += g_ranges[r].size; }
    uint64_t t1 = svcGetSystemTick();
    g_snapSections = (int)HeapSectionCount();
    g_snapPrev[0] = g_prevJump; g_snapPrev[1] = g_prevShoot; g_snapPrev[2] = g_prevDodge; g_snapPrev[3] = g_prevAlt;
    Logging.Log("[xplay] rollback: saved at frame %d: %lu KB in %d ranges, %.2f ms", g_frame,
                (unsigned long)(g_rangeBytes >> 10), g_nRanges, Ms(t1 - t0));
}

static void Restore() {
    if ((int)HeapSectionCount() != g_snapSections) {
        Logging.Log("[xplay] rollback: heap grew (%d -> %lu sections); not restoring", g_snapSections, (unsigned long)HeapSectionCount());
        g_nRanges = 0;
        return;
    }
    size_t dirty = 0, at = 0;
    for (int r = 0; r < g_nRanges; r++) {
        for (uintptr_t off = 0; off < g_ranges[r].size; off += 0x1000) {
            size_t n = g_ranges[r].size - off < 0x1000 ? g_ranges[r].size - off : 0x1000;
            if (std::memcmp(g_snap + at + off, (void*)(g_ranges[r].start + off), n) != 0) dirty++;
        }
        at += g_ranges[r].size;
    }
    DumpSoundList("before restore");
    ScanRanges(false, nullptr, nullptr);    /* fingerprints at the window's end, first pass */
    uint64_t t0 = svcGetSystemTick();
    size_t kept = 0;
    for (int i = 0; i < g_nKeep && kept + g_keep[i].size <= sizeof(g_keepBuf); i++) { std::memcpy(g_keepBuf + kept, (void*)g_keep[i].start, g_keep[i].size); kept += g_keep[i].size; }
    at = 0;
    for (int r = 0; r < g_nRanges; r++) { std::memcpy((void*)g_ranges[r].start, g_snap + at, g_ranges[r].size); at += g_ranges[r].size; }
    kept = 0;
    for (int i = 0; i < g_nKeep && kept + g_keep[i].size <= sizeof(g_keepBuf); i++) { std::memcpy((void*)g_keep[i].start, g_keepBuf + kept, g_keep[i].size); kept += g_keep[i].size; }
    uint64_t t1 = svcGetSystemTick();
    Logging.Log("[xplay] rollback: frame %d -> %d: %lu pages had changed (%lu KB); restored in %.2f ms", g_frame,
                kWindows[g_win].start, (unsigned long)dirty, (unsigned long)(dirty * 4), Ms(t1 - t0));
    DumpSoundList("after restore");
    g_frame = kWindows[g_win].start;
    g_prevJump = g_snapPrev[0]; g_prevShoot = g_snapPrev[1]; g_prevDodge = g_snapPrev[2]; g_prevAlt = g_snapPrev[3];
}

HOOK_DEFINE_TRAMPOLINE(FrameHook) {
    static void Callback(void* game, void* gameTime) {
        constexpr int kWindowCount = sizeof(kWindows) / sizeof(kWindows[0]);
        if (g_player && g_win < kWindowCount) {
            const Window& w = kWindows[g_win];
            if (g_pass == 0 && g_frame == w.start) { Save(); g_pass = g_nRanges ? 1 : 0; if (!g_nRanges) g_win++; }
            else if (g_pass == 1 && g_frame == w.start + w.length) { Restore(); g_pass = g_nRanges ? 2 : 0; if (!g_nRanges) g_win++; }
            else if (g_pass == 2 && g_frame == w.start + w.length) {
                size_t hc, gc;
                ScanRanges(true, &hc, &gc);
                Logging.Log("[xplay] rollback: replayed to frame %d: pages unlike the first pass: heap %lu, globals %lu%s",
                            g_frame, (unsigned long)hc, (unsigned long)gc, hc + gc ? "" : " (identical)");
                g_pass = 0; g_win++;
            }
        }
        Orig(game, gameTime);
    }
};

} // namespace xplay

extern "C" void exl_main(void* x0, void* x1) {
    exl::hook::Initialize();
    Logging.Log("[xplay] cross-play probe injected");
    xplay::MathCheck();
    xplay::ApplyFixes();
    xplay::g_getFullKey = reinterpret_cast<xplay::GetFullKeyFn>(
        xplay::FindExport("_ZN2nn3hid12GetNpadStateEPNS0_16NpadFullKeyStateERKj"));
    if (xplay::g_getFullKey) {
        *reinterpret_cast<volatile uintptr_t*>(xplay::Base() + xplay::off::NpadFullKeyStateSlot) =
            reinterpret_cast<uintptr_t>(&xplay::GetFullKeyHook);
    }
    xplay::NormalUpdateHook::InstallAtOffset(xplay::off::Player_NormalUpdate);
    if (*reinterpret_cast<uint32_t*>(xplay::Base() + xplay::off::TFGame_Update) == xplay::off::kTFGameUpdateInsn) {
        xplay::FrameHook::InstallAtOffset(xplay::off::TFGame_Update);
        xplay::GfxRingHook::InstallAtOffset(xplay::off::GfxRingAlloc);
    }
    else
        Logging.Log("[xplay] TFGame.Update isn't as expected: rollback test off");
    if (*reinterpret_cast<uint32_t*>(xplay::Base() + xplay::off::Player_Update_InputStore) == xplay::off::kInputStoreInsn)
        xplay::InputStoreHook::InstallAtOffset(xplay::off::Player_Update_InputStore);
    else
        Logging.Log("[xplay] Player.Update isn't as expected: InputState hook NOT installed");
    Logging.Log("[xplay] input hook %s, NormalUpdate hook installed", xplay::g_getFullKey ? "set" : "NOT set (export missing)");
}

extern "C" NORETURN void exl_exception_entry() {
    EXL_ABORT("Default exception handler called!");
}
