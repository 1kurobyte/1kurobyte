/*
** Force-included in the web build: glibc names the sources rely on that
** Emscripten's musl-based libc does not provide.
*/
#ifndef GLIBC_COMPAT_H
# define GLIBC_COMPAT_H

typedef float	_Float32;
typedef double	_Float64;

/* glibc's float variants of the <math.h> constants (_GNU_SOURCE). */
# define M_Ef		2.7182818284590452354f
# define M_LOG2Ef	1.4426950408889634074f
# define M_LOG10Ef	0.43429448190325182765f
# define M_LN2f		0.69314718055994530942f
# define M_LN10f	2.30258509299404568402f
# define M_PIf		3.14159265358979323846f
# define M_PI_2f	1.57079632679489661923f
# define M_PI_4f	0.78539816339744830962f
# define M_1_PIf	0.31830988618379067154f
# define M_2_PIf	0.63661977236758134308f
# define M_2_SQRTPIf	1.12837916709551257390f
# define M_SQRT2f	1.41421356237309504880f
# define M_SQRT1_2f	0.70710678118654752440f

#endif
