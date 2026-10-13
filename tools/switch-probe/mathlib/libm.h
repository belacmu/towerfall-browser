/* The bits of musl's internal libm.h that pow.c, pow_data.c and exp_data.c use, so they compile on
   their own (the browser's pow is this code, from Emscripten's musl). */
#ifndef XPLAY_LIBM_H
#define XPLAY_LIBM_H
#include <stdint.h>
#include <float.h>
#include <math.h>
#define WANT_ROUNDING 1
#define TOINT_INTRINSICS 0
#define WANT_SNAN 0
#define issignaling_inline(x) 0
#define predict_true(x) __builtin_expect(!!(x), 1)
#define predict_false(x) __builtin_expect(x, 0)
#define asuint64(f) ((union{double _f; uint64_t _i;}){f})._i
#define asdouble(i) ((union{uint64_t _i; double _f;}){i})._f
static inline double eval_as_double(double x) { return x; }
static inline double fp_barrier(double x) { volatile double y = x; return y; }
static inline void fp_force_eval(double x) { volatile double y; y = x; (void)y; }
#include "features.h"
static inline double __math_xflow(uint32_t sign, double y) { return fp_barrier(sign ? -y : y) * y; }
static inline double __math_oflow(uint32_t sign) { return __math_xflow(sign, 0x1p769); }
static inline double __math_uflow(uint32_t sign) { return __math_xflow(sign, 0x1p-767); }
static inline double __math_invalid(double x) { return (x - x) / (x - x); }
static inline double __math_divzero(uint32_t sign) { return fp_barrier(sign ? -1.0 : 1.0) / 0.0; }
#endif
