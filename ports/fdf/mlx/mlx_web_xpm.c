/*
** mlx_web_xpm.c - XPM3 loader for the web port of MiniLibX.
**
** Supports what minilibx-linux supports in practice: "#RGB"/"#RRGGBB"/
** "#RRRRGGGGBBBB" colours, "None" (transparent, stored as 0xFF000000 like
** minilibx does) and a handful of common X11 colour names.
*/

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "mlx.h"

typedef struct s_named
{
	const char	*name;
	uint32_t	rgb;
}	t_named;

static const t_named	g_names[] = {
{"black", 0x000000}, {"white", 0xFFFFFF}, {"red", 0xFF0000},
{"green", 0x00FF00}, {"blue", 0x0000FF}, {"yellow", 0xFFFF00},
{"cyan", 0x00FFFF}, {"magenta", 0xFF00FF}, {"gray", 0xBEBEBE},
{"grey", 0xBEBEBE}, {"orange", 0xFFA500}, {"brown", 0xA52A2A},
{NULL, 0}};

static int	hexval(int c)
{
	if (c >= '0' && c <= '9')
		return (c - '0');
	return (tolower(c) - 'a' + 10);
}

static uint32_t	parse_color(const char *s, size_t len)
{
	size_t	digits;
	size_t	i;
	uint32_t	ch[3];
	int		k;

	if (len > 0 && s[0] == '#')
	{
		digits = (len - 1) / 3;
		k = -1;
		while (++k < 3)
		{
			ch[k] = 0;
			i = 0;
			while (i < digits && i < 2)
			{
				ch[k] = ch[k] * 16 + (uint32_t)hexval(s[1 + k * digits + i]);
				i++;
			}
			if (digits == 1)
				ch[k] *= 17;
		}
		return ((ch[0] << 16) | (ch[1] << 8) | ch[2]);
	}
	if (len == 4 && strncasecmp(s, "none", 4) == 0)
		return (0xFF000000u);
	k = -1;
	while (g_names[++k].name)
		if (strlen(g_names[k].name) == len
			&& strncasecmp(s, g_names[k].name, len) == 0)
			return (g_names[k].rgb);
	return (0);
}

/* Returns the colour value following the "c" key of a colour definition. */
static uint32_t	color_from_def(const char *def)
{
	const char	*p;
	const char	*tok;
	size_t		len;

	p = def;
	while (*p)
	{
		while (*p == ' ' || *p == '\t')
			p++;
		tok = p;
		while (*p && *p != ' ' && *p != '\t')
			p++;
		if (p - tok == 1 && *tok == 'c')
		{
			while (*p == ' ' || *p == '\t')
				p++;
			len = strlen(p);
			while (len > 0 && (p[len - 1] == ' ' || p[len - 1] == '\t'))
				len--;
			return (parse_color(p, len));
		}
	}
	return (0);
}

void	*mlx_xpm_to_image(void *mlx_ptr, char **xpm, int *width, int *height)
{
	int			w;
	int			h;
	int			ncolors;
	int			cpp;
	char		*keys;
	uint32_t	*values;
	void		*img;
	uint32_t	*data;
	int			i;
	int			x;
	int			y;

	if (sscanf(xpm[0], "%d %d %d %d", &w, &h, &ncolors, &cpp) != 4
		|| w <= 0 || h <= 0 || ncolors <= 0 || cpp <= 0 || cpp > 8)
		return (NULL);
	keys = malloc((size_t)ncolors * (size_t)cpp);
	values = malloc((size_t)ncolors * sizeof(uint32_t));
	img = mlx_new_image(mlx_ptr, w, h);
	if (!keys || !values || !img)
		return (free(keys), free(values), mlx_destroy_image(mlx_ptr, img),
			NULL);
	i = -1;
	while (++i < ncolors)
	{
		memcpy(keys + i * cpp, xpm[1 + i], (size_t)cpp);
		values[i] = color_from_def(xpm[1 + i] + cpp);
	}
	data = (uint32_t *)(void *)mlx_get_data_addr(img, &x, &x, &x);
	y = -1;
	while (++y < h)
	{
		x = -1;
		while (++x < w)
		{
			i = 0;
			while (i < ncolors
				&& memcmp(keys + i * cpp, xpm[1 + ncolors + y] + x * cpp,
					(size_t)cpp) != 0)
				i++;
			data[y * w + x] = i < ncolors ? values[i] : 0;
		}
	}
	free(keys);
	free(values);
	*width = w;
	*height = h;
	return (img);
}

/* Collects every C string literal of an XPM file, in order. */
static char	**xpm_strings(char *buf, size_t *count)
{
	char	**v;
	size_t	cap;
	char	*p;
	char	*q;

	cap = 64;
	*count = 0;
	v = malloc(cap * sizeof(char *));
	p = buf;
	while (v && (p = strchr(p, '"')))
	{
		q = ++p;
		while (*q && *q != '"')
			q++;
		if (!*q)
			break ;
		*q = '\0';
		if (*count == cap)
		{
			cap *= 2;
			v = realloc(v, cap * sizeof(char *));
			if (!v)
				return (NULL);
		}
		v[(*count)++] = p;
		p = q + 1;
	}
	return (v);
}

void	*mlx_xpm_file_to_image(void *mlx_ptr, char *filename,
		int *width, int *height)
{
	FILE	*f;
	long	size;
	char	*buf;
	char	**lines;
	size_t	count;
	void	*img;

	f = fopen(filename, "rb");
	if (!f)
		return (NULL);
	fseek(f, 0, SEEK_END);
	size = ftell(f);
	fseek(f, 0, SEEK_SET);
	buf = malloc((size_t)size + 1);
	if (!buf || fread(buf, 1, (size_t)size, f) != (size_t)size)
		return (fclose(f), free(buf), NULL);
	fclose(f);
	buf[size] = '\0';
	lines = xpm_strings(buf, &count);
	img = NULL;
	if (lines && count > 0)
		img = mlx_xpm_to_image(mlx_ptr, lines, width, height);
	free(lines);
	free(buf);
	return (img);
}
