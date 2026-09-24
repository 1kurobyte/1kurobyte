/*
** mlx_web.c - MiniLibX implemented on top of an HTML <canvas>.
**
** The program is built with Emscripten's PROXY_TO_PTHREAD, so main() and
** mlx_loop() run in a Web Worker and are free to block forever, exactly like
** they do under X11. Only two things cross over to the browser's main thread:
**
**   - input events, which mlx_web.js writes into a lock-free ring buffer that
**     lives in (shared) wasm memory, and which mlx_loop() drains;
**   - finished frames, which mlx_put_image_to_window() converts from MLX's
**     0x00RRGGBB layout to RGBA and hands to the canvas.
**
** Events use the X11 numbering and keysyms of minilibx-linux, so hooks written
** for Linux work unchanged.
*/

#include <emscripten.h>
#include <emscripten/threading.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mlx.h"

#define MLX_EVENT_MAX 36
#define MLX_RING_CAP 512

#define EV_KEY_PRESS 2
#define EV_KEY_RELEASE 3
#define EV_BUTTON_PRESS 4
#define EV_BUTTON_RELEASE 5
#define EV_MOTION_NOTIFY 6
#define EV_EXPOSE 12
#define EV_DESTROY_NOTIFY 17

typedef int	(*t_fn1)(void *);
typedef int	(*t_fn2)(int, void *);
typedef int	(*t_fn3)(int, int, void *);
typedef int	(*t_fn4)(int, int, int, void *);

typedef struct s_hook
{
	void	*fn;
	void	*param;
}	t_hook;

typedef struct s_ring
{
	_Atomic int32_t	head;
	_Atomic int32_t	tail;
	int32_t			ev[MLX_RING_CAP][4];
}	t_ring;

typedef struct s_win
{
	int		width;
	int		height;
	t_hook	hooks[MLX_EVENT_MAX];
	int		mouse_x;
	int		mouse_y;
}	t_win;

typedef struct s_img
{
	int			width;
	int			height;
	uint32_t	*data;
}	t_img;

typedef struct s_mlx
{
	t_win		*win;
	t_hook		loop;
	t_ring		*ring;
	uint32_t	*rgba;
	size_t		rgba_len;
	int			running;
}	t_mlx;

void	*mlx_init(void)
{
	t_mlx	*m;

	m = calloc(1, sizeof(t_mlx));
	if (!m)
		return (NULL);
	m->ring = calloc(1, sizeof(t_ring));
	if (!m->ring)
		return (free(m), NULL);
	MAIN_THREAD_EM_ASM({ Module.mlx.attach($0, $1); },
		m->ring, MLX_RING_CAP);
	return (m);
}

void	*mlx_new_window(void *mlx_ptr, int size_x, int size_y, char *title)
{
	t_mlx	*m;
	t_win	*w;

	m = mlx_ptr;
	w = calloc(1, sizeof(t_win));
	if (!w)
		return (NULL);
	w->width = size_x;
	w->height = size_y;
	m->win = w;
	MAIN_THREAD_EM_ASM({ Module.mlx.createWindow($0, $1, UTF8ToString($2)); },
		size_x, size_y, title ? title : "");
	return (w);
}

int	mlx_clear_window(void *mlx_ptr, void *win_ptr)
{
	(void)mlx_ptr;
	(void)win_ptr;
	MAIN_THREAD_EM_ASM({ Module.mlx.clear(); });
	return (0);
}

int	mlx_pixel_put(void *mlx_ptr, void *win_ptr, int x, int y, int color)
{
	(void)mlx_ptr;
	(void)win_ptr;
	MAIN_THREAD_EM_ASM({ Module.mlx.pixel($0, $1, $2); }, x, y, color);
	return (0);
}

void	*mlx_new_image(void *mlx_ptr, int width, int height)
{
	t_img	*img;

	(void)mlx_ptr;
	if (width <= 0 || height <= 0)
		return (NULL);
	img = calloc(1, sizeof(t_img));
	if (!img)
		return (NULL);
	img->data = calloc((size_t)width * (size_t)height, sizeof(uint32_t));
	if (!img->data)
		return (free(img), NULL);
	img->width = width;
	img->height = height;
	return (img);
}

char	*mlx_get_data_addr(void *img_ptr, int *bits_per_pixel,
		int *size_line, int *endian)
{
	t_img	*img;

	img = img_ptr;
	if (bits_per_pixel)
		*bits_per_pixel = 32;
	if (size_line)
		*size_line = img->width * 4;
	if (endian)
		*endian = 0;
	return ((char *)img->data);
}

int	mlx_put_image_to_window(void *mlx_ptr, void *win_ptr, void *img_ptr,
		int x, int y)
{
	t_mlx		*m;
	t_img		*img;
	size_t		n;
	size_t		i;
	uint32_t	p;

	(void)win_ptr;
	m = mlx_ptr;
	img = img_ptr;
	n = (size_t)img->width * (size_t)img->height;
	if (m->rgba_len < n)
	{
		free(m->rgba);
		m->rgba = malloc(n * sizeof(uint32_t));
		m->rgba_len = m->rgba ? n : 0;
		if (!m->rgba)
			return (0);
	}
	i = 0;
	while (i < n)
	{
		p = img->data[i];
		m->rgba[i] = 0xFF000000u | ((p & 0xFFu) << 16) | (p & 0xFF00u)
			| ((p >> 16) & 0xFFu);
		i++;
	}
	MAIN_THREAD_EM_ASM({ Module.mlx.blit($0, $1, $2, $3, $4); },
		m->rgba, img->width, img->height, x, y);
	return (0);
}

int	mlx_get_color_value(void *mlx_ptr, int color)
{
	(void)mlx_ptr;
	return (color);
}

int	mlx_hook(void *win_ptr, int x_event, int x_mask,
		int (*funct)(), void *param)
{
	t_win	*w;

	(void)x_mask;
	w = win_ptr;
	if (!w || x_event < 0 || x_event >= MLX_EVENT_MAX)
		return (0);
	w->hooks[x_event].fn = (void *)funct;
	w->hooks[x_event].param = param;
	return (0);
}

int	mlx_mouse_hook(void *win_ptr, int (*funct_ptr)(), void *param)
{
	return (mlx_hook(win_ptr, EV_BUTTON_PRESS, 0, funct_ptr, param));
}

int	mlx_key_hook(void *win_ptr, int (*funct_ptr)(), void *param)
{
	return (mlx_hook(win_ptr, EV_KEY_RELEASE, 0, funct_ptr, param));
}

int	mlx_expose_hook(void *win_ptr, int (*funct_ptr)(), void *param)
{
	return (mlx_hook(win_ptr, EV_EXPOSE, 0, funct_ptr, param));
}

int	mlx_loop_hook(void *mlx_ptr, int (*funct_ptr)(), void *param)
{
	t_mlx	*m;

	m = mlx_ptr;
	m->loop.fn = (void *)funct_ptr;
	m->loop.param = param;
	return (0);
}

static void	dispatch(t_win *w, const int32_t *ev)
{
	t_hook	*h;

	if (ev[0] == EV_MOTION_NOTIFY || ev[0] == EV_BUTTON_PRESS
		|| ev[0] == EV_BUTTON_RELEASE)
	{
		w->mouse_x = ev[0] == EV_MOTION_NOTIFY ? ev[1] : ev[2];
		w->mouse_y = ev[0] == EV_MOTION_NOTIFY ? ev[2] : ev[3];
	}
	if (ev[0] < 0 || ev[0] >= MLX_EVENT_MAX || !w->hooks[ev[0]].fn)
		return ;
	h = &w->hooks[ev[0]];
	if (ev[0] == EV_KEY_PRESS || ev[0] == EV_KEY_RELEASE)
		((t_fn2)h->fn)(ev[1], h->param);
	else if (ev[0] == EV_BUTTON_PRESS || ev[0] == EV_BUTTON_RELEASE)
		((t_fn4)h->fn)(ev[1], ev[2], ev[3], h->param);
	else if (ev[0] == EV_MOTION_NOTIFY)
		((t_fn3)h->fn)(ev[1], ev[2], h->param);
	else
		((t_fn1)h->fn)(h->param);
}

static void	pump_events(t_mlx *m)
{
	int32_t	head;
	int32_t	tail;
	int32_t	ev[4];

	tail = atomic_load(&m->ring->tail);
	head = atomic_load(&m->ring->head);
	while (tail != head && m->running)
	{
		memcpy(ev, m->ring->ev[tail % MLX_RING_CAP], sizeof(ev));
		tail++;
		atomic_store(&m->ring->tail, tail);
		if (m->win)
			dispatch(m->win, ev);
	}
}

int	mlx_loop(void *mlx_ptr)
{
	t_mlx	*m;

	m = mlx_ptr;
	m->running = 1;
	while (m->running)
	{
		pump_events(m);
		if (!m->running)
			break ;
		if (m->loop.fn)
			((t_fn1)m->loop.fn)(m->loop.param);
		else
			emscripten_thread_sleep(16);
	}
	return (0);
}

int	mlx_loop_end(void *mlx_ptr)
{
	((t_mlx *)mlx_ptr)->running = 0;
	return (1);
}

int	mlx_string_put(void *mlx_ptr, void *win_ptr, int x, int y, int color,
		char *string)
{
	(void)mlx_ptr;
	(void)win_ptr;
	MAIN_THREAD_EM_ASM({ Module.mlx.text($0, $1, $2, UTF8ToString($3)); },
		x, y, color, string ? string : "");
	return (0);
}

void	mlx_set_font(void *mlx_ptr, void *win_ptr, char *name)
{
	(void)mlx_ptr;
	(void)win_ptr;
	(void)name;
}

int	mlx_destroy_window(void *mlx_ptr, void *win_ptr)
{
	t_mlx	*m;

	m = mlx_ptr;
	if (m && m->win == win_ptr)
		m->win = NULL;
	free(win_ptr);
	MAIN_THREAD_EM_ASM({ Module.mlx.destroyWindow(); });
	return (0);
}

int	mlx_destroy_image(void *mlx_ptr, void *img_ptr)
{
	t_img	*img;

	(void)mlx_ptr;
	img = img_ptr;
	if (!img)
		return (0);
	free(img->data);
	free(img);
	return (0);
}

int	mlx_destroy_display(void *mlx_ptr)
{
	t_mlx	*m;

	m = mlx_ptr;
	free(m->rgba);
	m->rgba = NULL;
	m->rgba_len = 0;
	return (0);
}

int	mlx_do_key_autorepeatoff(void *mlx_ptr)
{
	(void)mlx_ptr;
	MAIN_THREAD_EM_ASM({ Module.mlx.autorepeat = false; });
	return (0);
}

int	mlx_do_key_autorepeaton(void *mlx_ptr)
{
	(void)mlx_ptr;
	MAIN_THREAD_EM_ASM({ Module.mlx.autorepeat = true; });
	return (0);
}

int	mlx_do_sync(void *mlx_ptr)
{
	(void)mlx_ptr;
	return (0);
}

int	mlx_mouse_get_pos(void *mlx_ptr, void *win_ptr, int *x, int *y)
{
	t_win	*w;

	(void)mlx_ptr;
	w = win_ptr;
	*x = w ? w->mouse_x : 0;
	*y = w ? w->mouse_y : 0;
	return (0);
}

/*
** Under X11 programs re-centre the pointer to implement mouse-look. In the
** browser the pointer is captured with the Pointer Lock API instead and
** motion events carry an ever-accumulating virtual position, so the deltas a
** program computes between two events are exact and warping is a no-op.
*/
int	mlx_mouse_move(void *mlx_ptr, void *win_ptr, int x, int y)
{
	(void)mlx_ptr;
	(void)win_ptr;
	(void)x;
	(void)y;
	return (0);
}

int	mlx_mouse_hide(void *mlx_ptr, void *win_ptr)
{
	(void)mlx_ptr;
	(void)win_ptr;
	MAIN_THREAD_EM_ASM({ Module.mlx.hideCursor(true); });
	return (0);
}

int	mlx_mouse_show(void *mlx_ptr, void *win_ptr)
{
	(void)mlx_ptr;
	(void)win_ptr;
	MAIN_THREAD_EM_ASM({ Module.mlx.hideCursor(false); });
	return (0);
}

int	mlx_get_screen_size(void *mlx_ptr, int *sizex, int *sizey)
{
	(void)mlx_ptr;
	*sizex = MAIN_THREAD_EM_ASM_INT({ return screen.width; });
	*sizey = MAIN_THREAD_EM_ASM_INT({ return screen.height; });
	return (0);
}
