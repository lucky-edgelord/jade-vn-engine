#!/usr/bin/env python3
"""vnc: compile a Ren'Py-flavoured script (.rpy) into vn-engine's JSON bytecode.

    python3 tools/vnc.py OUT.json engine/stdlib.rpy game/*.rpy

Output keys:
  code        flat list of ops; control flow is compiled to jumps
  labels      label name -> pc
  init        Python source run once at boot (define, image, screen, init python, ...)
  defaults    Python source run at the start of every new game (`default` statements)
  transforms  ATL transforms, as JSON step lists
  files       source file list (diagnostics)
"""
import ast
import io
import json
import re
import sys
import tokenize


class CompileError(Exception):
    pass


# ---------------------------------------------------------------- source -> logical line tree
class Line:
    def __init__(self, fn, no, indent, text):
        self.fn, self.no, self.indent, self.text = fn, no, indent, text
        self.block = []

    def err(self, msg):
        return CompileError(f'{self.fn}:{self.no}: {msg}\n    {self.text}')

    @property
    def where(self):
        return f'{self.fn}:{self.no}'


def strip_comment(s):
    out, q, i = [], None, 0
    while i < len(s):
        c = s[i]
        if q:
            out.append(c)
            if c == '\\' and i + 1 < len(s):
                out.append(s[i + 1]); i += 2; continue
            if s.startswith(q, i):
                if len(q) == 3:
                    out.append(s[i + 1:i + 3]); i += 3
                else:
                    i += 1
                q = None
                continue
            i += 1
            continue
        else:
            if c == '#':
                break
            if s.startswith('"""', i) or s.startswith("'''", i):
                q = s[i:i + 3]; out.append(q); i += 3; continue
            if c in '"\'':
                q = c
        out.append(c); i += 1
    return ''.join(out).rstrip()


def read_lines(fn, text):
    raw = text.replace('\t', '    ').split('\n')
    logical, i = [], 0
    while i < len(raw):
        s = strip_comment(raw[i])
        no = i + 1
        i += 1
        if not s.strip():
            continue
        # join lines while brackets are open
        depth = bracket_depth(s)
        while depth > 0 and i < len(raw):
            s += ' ' + strip_comment(raw[i]).strip(); i += 1; depth = bracket_depth(s)
        indent = len(s) - len(s.lstrip(' '))
        logical.append(Line(fn, no, indent, s.strip()))
    root = Line(fn, 0, -1, '')
    stack = [root]
    for ln in logical:
        while ln.indent <= stack[-1].indent:
            stack.pop()
        stack[-1].block.append(ln)
        stack.append(ln)
    return root.block


def bracket_depth(s):
    d, q, i = 0, None, 0
    while i < len(s):
        c = s[i]
        if q:
            if c == '\\':
                i += 2; continue
            if c == q:
                q = None
        elif c in '"\'':
            q = c
        elif c in '([{':
            d += 1
        elif c in ')]}':
            d -= 1
        i += 1
    return d


def raw_python(line, base=None):
    """Return the python source of a `python:` block (dedented)."""
    out = []
    base = base if base is not None else (line.block[0].indent if line.block else 0)

    def walk(ls):
        for l in ls:
            out.append(' ' * (l.indent - base) + l.text)
            walk(l.block)
    walk(line.block)
    return '\n'.join(out)


# ---------------------------------------------------------------- small lexing helpers
STR_RE = r'''(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')'''


def take_string(s):
    m = re.match(r'\s*(' + STR_RE + r')', s)
    if not m:
        return None, s
    return ast.literal_eval(m.group(1)), s[m.end():]


def split_top(s, keywords):
    """Split `s` into (head, [(kw, expr), ...]) at top-level NAME tokens found in `keywords`."""
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(s).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        toks = None
    if toks is None:
        raise CompileError(f'cannot tokenize: {s}')
    cuts, depth, prev = [], 0, None
    for t in toks:
        if t.type == tokenize.OP and t.string in '([{':
            depth += 1
        elif t.type == tokenize.OP and t.string in ')]}':
            depth -= 1
        elif t.type == tokenize.NAME and depth == 0 and t.string in keywords:
            if not (prev is not None and prev.type == tokenize.OP and prev.string in ('.', '=')):
                cuts.append((t.start[1], t.end[1], t.string))
        if t.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER):
            prev = t
    head = s[:cuts[0][0]].strip() if cuts else s.strip()
    parts = []
    for i, (a, b, kw) in enumerate(cuts):
        end = cuts[i + 1][0] if i + 1 < len(cuts) else len(s)
        parts.append((kw, s[b:end].strip()))
    return head, parts


def literal(expr):
    try:
        return True, ast.literal_eval(expr)
    except Exception:
        return False, None


def interp_expr(sv):
    """Ren'Py-style "[var]" interpolation -> a python expression building the string."""
    if '[' not in sv:
        return repr(sv)
    parts, i, buf = [], 0, ''
    while i < len(sv):
        if sv.startswith('[[', i):
            buf += '['; i += 2; continue
        if sv[i] == '[':
            j = sv.find(']', i)
            if j < 0:
                buf += sv[i:]; break
            e = sv[i + 1:j]
            flag = None
            if '!' in e:
                e, flag = e.rsplit('!', 1)
            if buf:
                parts.append(repr(buf)); buf = ''
            x = f'str({e})'
            if flag == 'u':
                x += '.upper()'
            elif flag == 'l':
                x += '.lower()'
            parts.append(x); i = j + 1; continue
        buf += sv[i]; i += 1
    if buf:
        parts.append(repr(buf))
    return '(' + ' + '.join(parts) + ')' if parts else "''"


# ---------------------------------------------------------------- ATL
ATL_PROPS = {'xpos', 'ypos', 'pos', 'xanchor', 'yanchor', 'anchor', 'xalign', 'yalign', 'align', 'xoffset', 'yoffset', 'offset',
             'xcenter', 'ycenter', 'zoom', 'xzoom', 'yzoom', 'alpha', 'rotate', 'blend', 'tint', 'brightness', 'blur', 'crop',
             'xysize', 'xsize', 'ysize', 'additive', 'around', 'radius', 'angle', 'matrixcolor', 'fx'}
WARPERS = {'linear', 'ease', 'easein', 'easeout', 'ease_quad', 'ease_back', 'ease_bounce', 'ease_elastic'}


def atl_value(expr, line):
    ok, v = literal(expr)
    if ok:
        return v
    return {'e': expr}


def atl_props(text, line):
    head, parts = split_top(text, ATL_PROPS)
    if head:
        raise line.err(f'unexpected text in ATL: {head}')
    props = {}
    for k, v in parts:
        val = atl_value(v, line) if v else True
        if k == 'pos':
            props['xpos'], props['ypos'] = (val[0], val[1]) if isinstance(val, (list, tuple)) else (val, val)
        elif k == 'anchor':
            props['xanchor'], props['yanchor'] = val
        elif k == 'align':
            props['xalign'], props['yalign'] = val
        elif k == 'offset':
            props['xoffset'], props['yoffset'] = val
        elif k == 'xysize':
            props['xsize'], props['ysize'] = val
        else:
            props[k] = val
    return props


def compile_atl(lines):
    steps = []
    for l in lines:
        t = l.text.rstrip(':')
        w = t.split()
        if not w:
            continue
        if w[0] in WARPERS:
            dur = atl_value(w[1], l)
            rest = t.split(None, 2)[2] if len(w) > 2 else ''
            steps.append({'interp': w[0], 't': dur, 'props': atl_props(rest, l) if rest else {}})
        elif w[0] == 'pause':
            steps.append({'pause': atl_value(w[1], l)})
        elif w[0] == 'repeat':
            steps.append({'repeat': int(w[1]) if len(w) > 1 else None})
        elif w[0] in ('block', 'parallel'):
            steps.append({'block': compile_atl(l.block), 'parallel': w[0] == 'parallel'})
        elif w[0] in ('on', 'function', 'contains', 'choice', 'event', 'time'):
            continue  # not supported; ignored deliberately
        elif t[0] in '"\'':
            steps.append({'show': literal(t)[1]})
        elif re.match(r'^[\d.]+$', w[0]):
            steps.append({'pause': float(w[0])})
        else:
            steps.append({'set': atl_props(t, l)})
    return steps


# ---------------------------------------------------------------- screen language -> python
SCREEN_PROPS = {'pos', 'xpos', 'ypos', 'xalign', 'yalign', 'align', 'xanchor', 'yanchor', 'anchor', 'xoffset', 'yoffset', 'offset',
                'xysize', 'xsize', 'ysize', 'xmaximum', 'ymaximum', 'xminimum', 'yminimum', 'xfill', 'yfill', 'area',
                'xcenter', 'ycenter', 'spacing', 'padding', 'xpadding', 'ypadding', 'margin', 'background', 'hover_background',
                'selected_background', 'insensitive_background', 'idle', 'hover', 'selected_idle', 'selected_hover', 'insensitive',
                'action', 'hovered', 'unhovered', 'alternate', 'sensitive', 'selected', 'keysym', 'at', 'id', 'style', 'style_prefix',
                'size', 'color', 'hover_color', 'selected_color', 'insensitive_color', 'font', 'bold', 'italic', 'outlines',
                'outline_color', 'text_align', 'text_size', 'text_color', 'text_hover_color', 'text_selected_color',
                'text_insensitive_color', 'text_outlines', 'text_bold', 'text_italic', 'text_font', 'text_xalign', 'layout', 'zoom',
                'alpha', 'blend', 'tint', 'child_size', 'draggable', 'mousewheel', 'xinitial', 'yinitial', 'scrollx',
                'repeat', 'value', 'range', 'min_time', 'fail_action', 'cursor', 'tooltip', 'xadjustment', 'hover_sound',
                'activate_sound', 'focus_mask', 'shadow', 'line_spacing', 'kerning', 'slow_cps', 'modal', 'clip', 'rotate',
                'hover_alpha', 'hover_tint', 'hover_zoom', 'arrows', 'progress', 'bar_color', 'bar_background', 'xspacing',
                'yspacing', 'cols', 'rows', 'drag_dir', 'prompt', 'radius', 'stroke', 'vertical', 'thumb'}
DISPLAYABLES = {'add', 'text', 'textbutton', 'imagebutton', 'button', 'frame', 'fixed', 'hbox', 'vbox', 'grid', 'viewport',
                'window', 'null', 'bar', 'vbar', 'key', 'timer', 'dragbar', 'hotspot', 'label', 'image', 'side', 'mousearea'}
CONTAINERS = {'button', 'frame', 'fixed', 'hbox', 'vbox', 'grid', 'viewport', 'window', 'side'}
EVENT_PROPS = {'action', 'hovered', 'unhovered', 'alternate', 'fail_action'}


class ScreenCompiler:
    def __init__(self, comp):
        self.comp = comp
        self.out = []
        self.var = 0

    def emit(self, ind, s):
        self.out.append('    ' * ind + s)

    def compile(self, line, name, params):
        self.emit(0, f'def __scr_{name}(_sc{", " + params if params else ""}):')
        self.emit(1, '_p0 = []')
        opts = {}
        body = []
        for l in line.block:
            w = l.text.split(None, 1)
            if w[0] in ('modal', 'zorder', 'tag', 'layer', 'variant', 'style_prefix', 'sensitive'):
                opts[w[0]] = w[1] if len(w) > 1 else 'True'
            else:
                body.append(l)
        self.block(body, 1, 0)
        self.emit(1, 'return _p0')
        for k in ('tag', 'layer'):
            if k in opts and not opts[k].startswith(('"', "'")):
                opts[k] = repr(opts[k])
        o = ', '.join(f'{k}={v}' for k, v in opts.items() if k in ('modal', 'zorder', 'tag', 'layer'))
        self.emit(0, f'_screen({name!r}, __scr_{name}{", " + o if o else ""})')
        return '\n'.join(self.out)

    def block(self, lines, ind, depth):
        if not lines:
            self.emit(ind, 'pass')
            return
        for l in lines:
            self.stmt(l, ind, depth)

    def stmt(self, l, ind, depth):
        t = l.text
        w = t.split(None, 1)
        kw = w[0].rstrip(':')
        if t.startswith('$'):
            self.emit(ind, t[1:].strip())
        elif kw == 'python':
            for ln in raw_python(l).split('\n'):
                self.emit(ind, ln)
        elif kw in ('if', 'elif', 'while'):
            self.emit(ind, t if t.endswith(':') else t + ':')
            self.block(l.block, ind + 1, depth)
        elif kw == 'else':
            self.emit(ind, 'else:')
            self.block(l.block, ind + 1, depth)
        elif kw == 'for':
            self.emit(ind, t if t.endswith(':') else t + ':')
            self.block(l.block, ind + 1, depth)
        elif kw == 'pass':
            self.emit(ind, 'pass')
        elif kw == 'default':
            m = re.match(r'default\s+(\w+)\s*=\s*(.+)$', t)
            if not m:
                raise l.err('bad default')
            n, e = m.groups()
            self.emit(ind, f'if {n!r} not in _sc: _sc[{n!r}] = ({e})')
            self.emit(ind, f'{n} = _sc[{n!r}]')
        elif kw == 'use':
            m = re.match(r'use\s+(\w+)\s*(\((.*)\))?\s*$', t)
            if not m:
                raise l.err('bad use')
            n, _, args = m.groups()
            self.emit(ind, f"_p{depth}.extend(_SCREENS[{n!r}][0](_scopes.setdefault('use:' + {n!r}, {{}}){', ' + args if args else ''}))")
        elif kw in DISPLAYABLES:
            self.displayable(l, ind, depth)
        else:
            raise l.err(f'unknown screen statement {kw!r}')

    def displayable(self, l, ind, depth):
        t = l.text
        has_block = t.endswith(':')
        if has_block:
            t = t[:-1]
        kind, _, rest = t.partition(' ')
        head, props = split_top(rest, SCREEN_PROPS)
        child_props, child_disps = [], []
        for c in l.block:
            cw = c.text.split(None, 1)[0].rstrip(':')
            if cw in SCREEN_PROPS and not (cw in DISPLAYABLES):
                h2, p2 = split_top(c.text, SCREEN_PROPS)
                props += p2
            else:
                child_disps.append(c)
        d = f'_d{depth + 1}'
        self.emit(ind, f'{d} = {{"k": {kind!r}, "ln": {l.where!r}}}')
        self.emit(ind, f'_p{depth}.append({d})')
        if head:
            if kind in ('text', 'textbutton', 'label'):
                ok, sv = literal(head)
                self.emit(ind, f'{d}["v"] = {interp_expr(sv) if ok and isinstance(sv, str) else "str(" + head + ")"}')
            elif kind in ('add', 'image', 'imagebutton'):
                self.emit(ind, f'{d}["{"img" if kind != "imagebutton" else "idle"}"] = _disp_of({head})')
            elif kind == 'key':
                self.emit(ind, f'{d}["key"] = {head}')
            elif kind == 'timer':
                self.emit(ind, f'{d}["t"] = {head}')
            elif kind in ('hotspot', 'mousearea'):
                self.emit(ind, f'{d}["area"] = {head}')
            elif kind == 'grid':
                gp = head.replace(',', ' ').split()
                self.emit(ind, f'{d}["cols"] = {gp[0]}')
                if len(gp) > 1:
                    self.emit(ind, f'{d}["rows"] = {gp[1]}')
            else:
                raise l.err(f'{kind} takes no positional argument')
        for k, v in props:
            if k in EVENT_PROPS:
                self.emit(ind, f'_a = ({v})')
                self.emit(ind, f'{d}["{k}"] = _A(_a)')
                if k == 'action':
                    self.emit(ind, f'if "sens" not in {d}: {d}["sens"] = _sens(_a)')
                    self.emit(ind, f'if "sel" not in {d}: {d}["sel"] = _sel(_a)')
            elif k == 'sensitive':
                self.emit(ind, f'{d}["sens"] = bool({v})')
            elif k == 'selected':
                self.emit(ind, f'{d}["sel"] = bool({v})')
            elif k == 'at':
                names = [x.strip() for x in v.split(',')]
                if all(re.match(r'^\w+$', x) for x in names):
                    self.emit(ind, f'{d}["at"] = {names!r}')
                else:
                    self.emit(ind, f'{d}["at"] = _plain([{v}])')
            elif k in ('background', 'hover_background', 'selected_background', 'insensitive_background', 'idle', 'hover',
                       'selected_idle', 'selected_hover', 'insensitive', 'bar_background', 'thumb'):
                self.emit(ind, f'{d}["{k}"] = _disp_of({v})')
            elif k == 'tooltip':
                self.emit(ind, f'{d}["tooltip"] = _interp(str({v}))')
            elif v == '':
                self.emit(ind, f'{d}["{k}"] = True')
            else:
                self.emit(ind, f'{d}["{k}"] = _plain({v})')
        if kind in CONTAINERS or child_disps:
            if child_disps and kind not in CONTAINERS:
                raise l.err(f'{kind} cannot have children')
            self.emit(ind, f'_p{depth + 1} = {d}["c"] = []')
            self.block(child_disps, ind, depth + 1) if child_disps else None


# ---------------------------------------------------------------- script statements -> ops
class Compiler:
    def __init__(self):
        self.code = []
        self.labels = {}
        self.init = []        # (priority, order, source)
        self.defaults = []
        self.transforms = {}
        self.atl_n = 0
        self.order = 0
        self.pending_label_jumps = []

    def add_init(self, src, prio=0):
        self.order += 1
        self.init.append((prio, self.order, src))

    def op(self, *a):
        self.code.append(list(a))
        return len(self.code) - 1

    def toplevel(self, lines):
        for l in lines:
            t = l.text
            w = t.split(None, 1)
            kw = w[0].rstrip(':')
            if kw == 'label':
                m = re.match(r'label\s+([\w.]+)\s*:$', t)
                if not m:
                    raise l.err('bad label')
                self.label(m.group(1), l)
            elif kw == 'init':
                m = re.match(r'init\s*(-?\d+)?\s*(python)?\s*(early)?\s*:$', t)
                if not m:
                    raise l.err('bad init')
                prio = int(m.group(1) or 0)
                if m.group(2):
                    self.add_init(raw_python(l), prio)
                else:
                    for c in l.block:
                        self.toplevel_decl(c, prio)
            elif kw == 'python' and t.rstrip(':') in ('python', 'python early'):
                self.add_init(raw_python(l), 0)
            else:
                self.toplevel_decl(l, 0)

    def toplevel_decl(self, l, prio):
        t = l.text
        w = t.split(None, 1)
        kw = w[0].rstrip(':')
        if kw == 'define':
            m = re.match(r'define\s+(-?\d+\s+)?([\w.]+)\s*(=|\+=|\|=)\s*(.+)$', t)
            if not m:
                raise l.err('bad define')
            self.add_init(f'{m.group(2)} {m.group(3)} {m.group(4)}', prio)
        elif kw == 'default':
            m = re.match(r'default\s+([\w.]+)\s*=\s*(.+)$', t)
            if not m:
                raise l.err('bad default')
            n, e = m.groups()
            if n.startswith('persistent.'):
                self.add_init(f'if {n} is None: {n} = {e}', prio)
            else:
                self.defaults.append(f'_default({n!r}, {e})')
                self.add_init(f'_default({n!r}, {e})', prio + 1000)   # so screens can read it before Start
        elif kw == 'image':
            m = re.match(r'image\s+([\w ]+?)\s*=\s*(.+)$', t)
            if m:
                self.add_init(f'_img({m.group(1).strip()!r}, {m.group(2)})', prio)
            else:
                m = re.match(r'image\s+([\w ]+?)\s*:$', t)
                if not m:
                    raise l.err('bad image')
                name = m.group(1).strip()
                steps = compile_atl(l.block)
                tn = f'__img_{name.replace(" ", "_")}'
                self.transforms[tn] = steps
                self.add_init(f'_img({name!r}, {{"k": "atl", "atl": {tn!r}}})', prio)
        elif kw == 'transform':
            m = re.match(r'transform\s+(\w+)\s*(\(.*\))?\s*:$', t)
            if not m:
                raise l.err('bad transform')
            self.transforms[m.group(1)] = compile_atl(l.block)
        elif kw == 'screen':
            m = re.match(r'screen\s+(\w+)\s*(?:\((.*)\))?\s*:$', t)
            if not m:
                raise l.err('bad screen')
            src = ScreenCompiler(self).compile(l, m.group(1), m.group(2) or '')
            self.add_init(src, prio)
        elif kw in ('style', 'translate', 'testcase'):
            pass  # styles are expressed as screen properties / gui variables here
        else:
            raise l.err(f'unexpected top-level statement {kw!r}')

    # ---- labels and their bodies
    def label(self, name, l):
        if name in self.labels:
            raise l.err(f'label {name} defined twice')
        self.labels[name] = len(self.code)
        self.op('label', name)
        self.block(l.block)

    def block(self, lines):
        i = 0
        while i < len(lines):
            l = lines[i]
            kw = l.text.split(None, 1)[0].rstrip(':')
            if kw == 'if':
                chain = [l]
                while i + 1 < len(lines) and lines[i + 1].text.split(None, 1)[0].rstrip(':') in ('elif', 'else'):
                    i += 1
                    chain.append(lines[i])
                self.if_chain(chain)
            elif kw in ('elif', 'else'):
                raise l.err(f'{kw} without if')
            else:
                self.stmt(l)
            i += 1

    def if_chain(self, chain):
        ends = []
        for c in chain:
            t = c.text.rstrip(':')
            if t.startswith('else'):
                self.block(c.block)
            else:
                cond = t.split(None, 1)[1]
                jf = self.op('jf', cond, None)
                self.block(c.block)
                ends.append(self.op('jmp', None))
                self.code[jf][2] = len(self.code)
        for e in ends:
            self.code[e][1] = len(self.code)

    def stmt(self, l):
        t = l.text
        w = t.split(None, 1)
        kw = w[0].rstrip(':')
        rest = w[1] if len(w) > 1 else ''
        if t.startswith('$'):
            self.op('py', t[1:].strip(), l.where)
        elif kw == 'python':
            self.op('py', raw_python(l), l.where)
        elif kw == 'pass':
            pass
        elif kw == 'while':
            cond = t.rstrip(':').split(None, 1)[1]
            top = len(self.code)
            jf = self.op('jf', cond, None)
            self.block(l.block)
            self.op('jmp', top)
            self.code[jf][2] = len(self.code)
        elif kw == 'jump':
            if rest.startswith('expression '):
                self.op('jmpx', rest[len('expression '):])
            else:
                self.op('jmpl', rest.strip())
        elif kw == 'call':
            if rest.startswith('screen '):
                n, a, tr = self.screen_ref(rest[len('screen '):], l)
                self.op('scall', n, a, tr)
            elif rest.startswith('expression '):
                self.op('callx', rest[len('expression '):])
            else:
                self.op('call', rest.split()[0])
        elif kw == 'return':
            self.op('ret', rest or None)
        elif kw == 'show' and rest.startswith('screen '):
            n, a, tr = self.screen_ref(rest[len('screen '):], l)
            self.op('sshow', n, a, tr)
        elif kw == 'hide' and rest.startswith('screen '):
            n, a, tr = self.screen_ref(rest[len('screen '):], l)
            self.op('shide', n, tr)
        elif kw in ('scene', 'show'):
            self.op(kw, self.image_spec(rest, l, kw))
            spec = self.code[-1][1]
            if spec.get('with'):
                self.op('with', spec.pop('with'))
        elif kw == 'hide':
            head, parts = split_top(rest, {'onlayer', 'with'})
            p = dict(parts)
            self.op('hide', head.split()[0], p.get('onlayer', 'master'))
            if p.get('with'):
                self.op('with', p['with'])
        elif kw == 'with':
            self.op('with', rest)
        elif kw in ('play', 'queue'):
            ch, _, r2 = rest.partition(' ')
            head, parts = split_top(r2, {'loop', 'noloop', 'fadein', 'fadeout', 'volume', 'if_changed'})
            opts = {}
            for k, v in parts:
                if k in ('loop', 'noloop'):
                    opts['loop'] = k == 'loop'
                elif k == 'if_changed':
                    opts['if_changed'] = True
                else:
                    opts[k] = literal(v)[1] if literal(v)[0] else {'e': v}
            if kw == 'queue':
                opts['queue'] = True
            ok, f = literal(head)
            self.op('play', ch, f if ok else {'e': head}, opts)
        elif kw == 'stop':
            ch, _, r2 = rest.partition(' ')
            head, parts = split_top(r2, {'fadeout'})
            self.op('stop', ch, {k: literal(v)[1] for k, v in parts})
        elif kw == 'voice':
            ok, f = literal(rest)
            self.op('voice', f if ok else {'e': rest})
        elif kw == 'pause':
            self.op('pause', literal(rest)[1] if rest else None)
        elif kw == 'window':
            self.op('window', rest)
        elif kw == 'nvl':
            pass
        elif kw == 'menu':
            self.menu(l)
        elif kw == 'label':
            m = re.match(r'label\s+([\w.]+)\s*:$', t)
            if not m:
                raise l.err('bad label')
            self.labels[m.group(1)] = len(self.code)
            self.op('label', m.group(1))
            self.block(l.block)
        elif kw in ('define', 'default', 'image', 'transform', 'screen', 'init'):
            self.toplevel_decl(l, 0)
        else:
            self.say(l)

    def screen_ref(self, s, l):
        head, parts = split_top(s, {'with', 'nopredict', 'onlayer', 'zorder'})
        p = dict(parts)
        m = re.match(r'(\w+)\s*(\((.*)\))?$', head.strip())
        if not m:
            raise l.err('bad screen reference')
        args = m.group(3)
        return m.group(1), (f'dict({args})' if args else None), p.get('with')

    def image_spec(self, rest, l, kw):
        has_atl = rest.endswith(':')
        if has_atl:
            rest = rest[:-1]
        head, parts = split_top(rest, {'as', 'at', 'behind', 'zorder', 'onlayer', 'with'})
        spec = {'layer': 'master'}
        if head.startswith('expression '):
            spec['expr'] = head[len('expression '):]
        elif head:
            spec['img'] = ' '.join(head.split())
        for k, v in parts:
            if k == 'as':
                spec['tag'] = v
            elif k == 'at':
                spec['at'] = [x.strip() for x in v.split(',') if x.strip()]
            elif k == 'behind':
                spec['behind'] = [x.strip() for x in v.split(',')]
            elif k == 'zorder':
                spec['zorder'] = literal(v)[1]
            elif k == 'onlayer':
                spec['layer'] = v
            elif k == 'with':
                spec['with'] = v
        if has_atl:
            self.atl_n += 1
            tn = f'__atl{self.atl_n}'
            self.transforms[tn] = compile_atl(l.block)
            spec.setdefault('at', []).append(tn)
        if 'tag' not in spec and 'img' in spec:
            spec['tag'] = spec['img'].split()[0]
        if kw == 'scene' and not head:
            spec.pop('layer', None)
            spec['layer'] = 'master'
        return spec

    def menu(self, l):
        caption = None
        items = []
        for c in l.block:
            t = c.text
            if t.startswith(('"', "'")) and t.endswith(':'):
                s, rest = take_string(t[:-1])
                rest = rest.strip()
                cond = None
                if rest.startswith('if '):
                    cond = rest[3:].strip()
                items.append([s, cond, c])
            elif t.startswith('set '):
                continue
            else:
                if caption is not None:
                    raise c.err('only one caption line allowed in a menu')
                caption = self.parse_say(c)
        mi = self.op('menu', [[s, cond, None] for s, cond, _ in items], caption)
        ends = []
        for k, (s, cond, c) in enumerate(items):
            self.code[mi][1][k][2] = len(self.code)
            self.block(c.block)
            ends.append(self.op('jmp', None))
        for e in ends:
            self.code[e][1] = len(self.code)

    def parse_say(self, l):
        t = l.text
        who = None
        s, rest = take_string(t)
        if s is None:
            m = re.match(r'([\w.]+)\s+(.*)$', t)
            if not m:
                raise l.err('cannot parse statement')
            who = m.group(1)
            s, rest = take_string(m.group(2))
            if s is None:
                raise l.err('cannot parse statement')
        else:
            s2, rest2 = take_string(rest)
            if s2 is not None:
                who, s, rest = repr(s), s2, rest2
        rest = rest.strip()
        withx = None
        if rest.startswith('with '):
            withx = rest[5:].strip()
        elif rest:
            raise l.err(f'unexpected text after say: {rest}')
        return ['say', who, s, l.where, withx]

    def say(self, l):
        op = self.parse_say(l)
        self.code.append(op)

    def finish(self):
        self.op('end')
        for i, o in enumerate(self.code):
            if o[0] in ('jmpl', 'call') and o[1] not in self.labels:
                raise CompileError(f'op {i}: unknown label {o[1]!r}')
        init = '\n'.join(src for _, _, src in sorted(self.init, key=lambda x: (x[0], x[1])))
        try:
            compile(init, '<init>', 'exec')
        except SyntaxError as e:
            lines = init.split('\n')
            ctx = '\n'.join(lines[max(0, e.lineno - 4):e.lineno + 1])
            raise CompileError(f'generated python does not compile ({e.msg}):\n{ctx}')
        for i, o in enumerate(self.code):
            if o[0] == 'py':
                try:
                    compile(o[1], o[2], 'exec')
                except SyntaxError as e:
                    raise CompileError(f'{o[2]}: python syntax error: {e.msg}')
        return {'code': self.code, 'labels': self.labels, 'init': init, 'defaults': '\n'.join(self.defaults),
                'transforms': self.transforms}


def compile_files(paths):
    import os
    c = Compiler()
    for p in paths:
        with open(p, encoding='utf-8') as f:
            rel = os.path.join(os.path.basename(os.path.dirname(p)), os.path.basename(p))
            c.toplevel(read_lines(rel, f.read()))
    out = c.finish()
    out['files'] = paths
    return out


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    try:
        g = compile_files(sys.argv[2:])
    except CompileError as e:
        print('error:', e, file=sys.stderr)
        sys.exit(1)
    with open(sys.argv[1], 'w', encoding='utf-8') as f:
        json.dump(g, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(g["code"])} ops, {len(g["labels"])} labels, {len(g["transforms"])} transforms, init {len(g["init"])} chars')
