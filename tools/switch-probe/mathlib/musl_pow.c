/* musl's pow (from Emscripten's copy: what the browser's Math.Pow runs), built the way WebAssembly
   runs it: no fused multiply-add path, no contraction (compile with -ffp-contract=off). */
#undef __FP_FAST_FMA
#include <math.h>
#define pow xplay_musl_pow
#include "pow.c"
