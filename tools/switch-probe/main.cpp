/*
 * TowerFall Switch — cross-play probe (exlaunch module)
 * -----------------------------------------------------
 * Step 2 of the Switch × browser rollback feasibility plan
 * (towerfall-browser: docs/SWITCH-CROSSPLAY.md). Changes nothing in the game.
 * Its own exlaunch checkout (copied from ~/Code/tf3-exlaunch's build setup).
 *
 * 2c: the game's Math.Sin/Cos/Atan2/Pow are tail calls into the SDK's sin/cos/
 * atan2/pow (imports; Math.Sqrt is an inline fsqrt). This calls those same
 * functions (nnSdk's exports, which the game's import slots bind to), on the
 * same inputs as the browser's "mathtest" host command
 * (web/Determinism.cs), and logs a hash of the result bits per function.
 * Also logs FPCR (flush-to-zero / default-NaN / rounding mode).
 *
 * Output: the guest log ("[xplay] ..." lines in Ryujinx's log).
 * Offsets: TowerFall v1.4.1.6 main, flat-image (module-base-relative).
 */

#include "lib.hpp"
#include "loggers.hpp"
#include <lib/util/sys/modules.hpp>

#include <cstdint>
#include <cstring>

namespace xplay {

/* The game's import slots for them (main, v1.4.1.6), for reference: sin +0x4722548,
 * cos +0x4722550, atan2 +0x4722590, pow +0x47225b0. */

/* musl's pow as the browser runs it (source/program/mathlib: Emscripten's musl, no FMA path,
 * -ffp-contract=off). The SDK's pow differs from the browser's; this is the fix. */
extern "C" double xplay_musl_pow(double, double);

using Fn1 = double (*)(double);
using Fn2 = double (*)(double, double);

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

/* The address of an exported (defined) function in any loaded module, from its
 * dynamic symbol table. At exl_main time the game's own import slots aren't
 * bound yet (calling through them crashed in rtld's lazy binder), so the
 * functions they will point at are looked up where they're defined (nnSdk). */
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

static void Run() {
    auto sin_ = reinterpret_cast<Fn1>(FindExport("sin"));
    auto cos_ = reinterpret_cast<Fn1>(FindExport("cos"));
    auto atan2_ = reinterpret_cast<Fn2>(FindExport("atan2"));
    auto pow_ = reinterpret_cast<Fn2>(FindExport("pow"));
    Logging.Log("[xplay] exports: sin %p cos %p atan2 %p pow %p", (void*)sin_, (void*)cos_, (void*)atan2_, (void*)pow_);
    if (!sin_ || !cos_ || !atan2_ || !pow_) return;

    uint64_t fpcr;
    asm volatile("mrs %0, fpcr" : "=r"(fpcr));
    Logging.Log("[xplay] FPCR=%#llx (FZ=%d DN=%d RMode=%d)", (unsigned long long)fpcr,
                (int)((fpcr >> 24) & 1), (int)((fpcr >> 25) & 1), (int)((fpcr >> 22) & 3));

    Hash hs, hc, ha, hp, hm;
    state = 2463534242u;
    constexpr int N = 100000;
    for (int i = 0; i < N; i++) {
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
    Logging.Log("[xplay] mathtest sin %016llx cos %016llx atan2 %016llx pow %016llx",
                (unsigned long long)hs.h, (unsigned long long)hc.h, (unsigned long long)ha.h, (unsigned long long)hp.h);
    Logging.Log("[xplay] mathtest musl pow (the fix) %016llx", (unsigned long long)hm.h);

    /* The fix itself: the game's pow import now goes to musl's pow, so its Math.Pow computes what
     * the browser's does. (Written before the game's first call: lazy binding never replaces it.) */
    constexpr uintptr_t kPowImportSlot = 0x47225b0;
    uintptr_t base = exl::util::GetMainModuleInfo().m_Total.m_Start;
    /* Lazily bound import slots are ordinary writable data (CodePatcher's code mirror doesn't
     * cover them: it crashed). */
    *reinterpret_cast<volatile uintptr_t*>(base + kPowImportSlot) = reinterpret_cast<uintptr_t>(&xplay_musl_pow);
    Logging.Log("[xplay] game's pow import -> musl pow (%s)",
                *reinterpret_cast<uintptr_t*>(base + kPowImportSlot) == reinterpret_cast<uintptr_t>(&xplay_musl_pow) ? "set" : "NOT set");

    /* A few raw values, for a first look if a hash differs. */
    Logging.Log("[xplay] sin(1)=%a cos(1)=%a atan2(1,2)=%a pow(0.98f,0.5)=%a", sin_(1.0), cos_(1.0),
                atan2_(1.0, 2.0), pow_(0.9800000190734863, 0.5));
}

} // namespace xplay

extern "C" void exl_main(void* x0, void* x1) {
    exl::hook::Initialize();
    Logging.Log("[xplay] cross-play probe injected");
    xplay::Run();
}

extern "C" NORETURN void exl_exception_entry() {
    EXL_ABORT("Default exception handler called!");
}
