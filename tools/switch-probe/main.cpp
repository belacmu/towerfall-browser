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
    if (*reinterpret_cast<uint32_t*>(xplay::Base() + xplay::off::Player_Update_InputStore) == xplay::off::kInputStoreInsn)
        xplay::InputStoreHook::InstallAtOffset(xplay::off::Player_Update_InputStore);
    else
        Logging.Log("[xplay] Player.Update isn't as expected: InputState hook NOT installed");
    Logging.Log("[xplay] input hook %s, NormalUpdate hook installed", xplay::g_getFullKey ? "set" : "NOT set (export missing)");
}

extern "C" NORETURN void exl_exception_entry() {
    EXL_ABORT("Default exception handler called!");
}
