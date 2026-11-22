# vn-engine Python prelude: runs inside MicroPython (WebAssembly) in the browser.
# Everything here and every game script's python executes in one namespace: the store.
# JS talks to this module through a handful of functions prefixed with an underscore.
import json
import re

_store = globals()
_cmds = []            # commands queued for the JS side (sound, notify, save, ...)
_defaults = []        # names declared with `default` (saved / rolled back)
_ACTS = []            # actions referenced by the last screen render
_SCREENS = {}         # name -> [fn, {'modal':..,'zorder':..,'tag':..}]
_scopes = {}          # screen name -> screen-local variables
_screen_args = {}     # screen name -> kwargs it was shown with
_cur_scope = None
_images = {}          # image name -> displayable dict
_trans_names = {}


def _cmd(*a):
    _cmds.append(list(a))


def _drain():
    global _cmds
    c = _cmds
    _cmds = []
    return _js(c)


# ---------------------------------------------------------------- JSON helpers
def _plain(v, depth=0):
    """Convert to something json.dumps accepts (MicroPython json has no default= hook)."""
    if v is None or v is True or v is False or isinstance(v, (int, float, str)):
        return v
    if depth > 12:
        return None
    if isinstance(v, (list, tuple)):
        return [_plain(x, depth + 1) for x in v]
    if isinstance(v, dict):
        return {str(k): _plain(x, depth + 1) for k, x in v.items()}
    if isinstance(v, set):
        return {'__set__': [_plain(x, depth + 1) for x in v]}
    if hasattr(v, '_disp'):
        return v._disp()
    return None


def _js(v):
    return json.dumps(_plain(v))


def _revive(v):
    if isinstance(v, dict):
        if '__set__' in v and len(v) == 1:
            return set(_revive(x) for x in v['__set__'])
        return {k: _revive(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_revive(x) for x in v]
    return v


# ---------------------------------------------------------------- control flow from python
class _Ctl(Exception):
    def __init__(self, kind, arg=None, extra=None):
        self.kind = kind
        self.arg = arg
        self.extra = extra


class _Renpy:
    """A small `renpy` module look-alike."""

    def jump(self, label):
        raise _Ctl('jump', label)

    def call(self, label):
        raise _Ctl('call', label)

    def notify(self, msg):
        _cmd('notify', str(msg))

    def play(self, f, channel='sound', loop=None, fadein=0, volume=1.0):
        _cmd('play', channel, f, {'loop': loop, 'fadein': fadein, 'volume': volume})

    def stop(self, channel='sound', fadeout=0):
        _cmd('stop', channel, {'fadeout': fadeout})

    def restart_interaction(self):
        _cmd('refresh')

    def show_screen(self, name, *a, **kw):
        _screen_args[name] = _args(*a, **kw)
        _cmd('show_screen', name)

    def hide_screen(self, name):
        _cmd('hide_screen', name)

    def get_screen(self, name):
        return name in _shown_screens

    def shake(self, t=0.5, amp=12, axis='v'):
        _cmd('shake', t, amp, axis)

    def flash(self, color='#fff', t=0.4):
        _cmd('flash', color, t)

    def fx(self, name, **params):
        """Set or tweak a post-processing effect (mosh-style). renpy.fx('rgbshift', amount=0.01)."""
        _cmd('fx', name, params)

    def fx_off(self, name=None):
        _cmd('fx_off', name)

    def analog(self, hiss=0.02, hum=0.012, whine=0.003, rumble=0.0, hz=60, fade=0.6):
        """Generated analog bed: tape hiss, mains hum (hz=60 or 50) with harmonics, CRT flyback whine, motor rumble."""
        _cmd('analog', {'hiss': hiss, 'hum': hum, 'whine': whine, 'rumble': rumble, 'hz': hz, 'fade': fade})

    def analog_off(self):
        _cmd('analog', False)

    def pause(self, t):
        raise _Ctl('pause', t)

    def random(self):
        return _rand()

    def seen_label(self, label):
        return label in persistent._seen_labels

    def music_register(self, name, loop=False, mixer='sfx'):
        _cmd('channel', name, {'loop': loop, 'mixer': mixer})


renpy = _Renpy()
_shown_screens = set()

_seed = [12345]


def _rand():
    _seed[0] = (_seed[0] * 1103515245 + 12345) & 0x7fffffff
    return _seed[0] / 0x7fffffff


def randint(a, b):
    return a + int(_rand() * (b - a + 1)) if b > a else a


def choice(seq):
    return seq[randint(0, len(seq) - 1)]


# ---------------------------------------------------------------- persistent data
class _Persistent:
    def __init__(self):
        self._seen_labels = set()

    def __getattr__(self, k):
        return None


persistent = _Persistent()


def _persist_dump():
    return _js({k: v for k, v in persistent.__dict__.items()})


def _persist_load(s):
    d = _revive(json.loads(s))
    for k, v in d.items():
        setattr(persistent, k, v)
    if not isinstance(persistent.__dict__.get('_seen_labels'), set):
        persistent._seen_labels = set()


class _Prefs:
    def __init__(self):
        self.text_cps = 45
        self.auto_delay = 1.5
        self.music = 0.8
        self.sfx = 0.9
        self.voice = 1.0
        self.skip_unseen = False
        self.fx = True


preferences = _Prefs()


def _prefs_dump():
    return _js(preferences.__dict__)


def _prefs_load(s):
    for k, v in json.loads(s).items():
        setattr(preferences, k, v)


# ---------------------------------------------------------------- characters
class Character:
    def __init__(self, name=None, kind=None, **kw):
        if kind is not None:
            for k, v in kind.__dict__.items():
                setattr(self, k, v)
        else:
            self.name = None
            self.who_color = '#ffffff'
            self.what_color = '#ffffff'
            self.what_italic = False
            self.what_prefix = ''
            self.what_suffix = ''
            self.image = None
            self.voice_tag = None
            self.callback = None
            self.ctc = True
        if name is not None or kind is None:
            self.name = name
        for k, v in kw.items():
            setattr(self, k, v)

    def __call__(self, what, **kw):
        raise _Ctl('say', [self, what])


narrator = Character(None)
centered = Character(None, what_center=True)


def _say(who, what, expr=False):
    if expr and who is not None:
        who = eval(who, _store)
    c = who if who is not None else narrator
    if isinstance(c, str):
        c = Character(c)
    if c.callback:
        c.callback('begin')
    d = {'who': _interp(c.name) if c.name else None, 'what': c.what_prefix + _interp(what) + c.what_suffix,
         'who_color': c.who_color, 'what_color': c.what_color, 'italic': c.what_italic,
         'center': getattr(c, 'what_center', False), 'image': c.image, 'voice_tag': c.voice_tag}
    _store['_last_say_who'] = d['who']
    return _js(d)


_interp_re = re.compile(r'\[([^\[\]]+)\]')


def _interp(s):
    if s is None or '[' not in s:
        return s
    s = s.replace('[[', '\x01')

    def rep(m):
        e = m.group(1)
        flag = None
        if '!' in e:
            e, flag = e.rsplit('!', 1)
        v = eval(e, _store)
        v = str(v)
        if flag == 'u':
            v = v.upper()
        elif flag == 'l':
            v = v.lower()
        elif flag == 'c':
            v = v[:1].upper() + v[1:]
        return v
    return _interp_re.sub(rep, s).replace('\x01', '[')


# ---------------------------------------------------------------- displayables
class Displayable:
    def _disp(self):
        return self.__dict__


class Solid(Displayable):
    def __init__(self, color, xysize=None, **kw):
        self.k = 'solid'
        self.color = color
        self.xysize = xysize
        for _k, _v in kw.items():
            setattr(self, _k, _v)


class Image(Displayable):
    def __init__(self, src, **kw):
        self.k = 'img'
        self.src = src
        for _k, _v in kw.items():
            setattr(self, _k, _v)


class Radial(Displayable):
    """Radial gradient: Radial(((0, '#f008'), (1, '#f000')), xysize=(600, 600))."""

    def __init__(self, stops, xysize=None):
        self.k = 'radial'
        self.stops = [list(s) for s in stops]
        self.xysize = xysize


class Light:
    """A light for LightMap. x, y in the LightMap's own pixels.
    radius, color, intensity; cut (how much darkness it removes), tint (how much colour it adds),
    flicker 0..1, shadows (ray-cast against the LightMap's occluders), cone=(direction_deg, spread_deg),
    falloff 0..1, core (radius of a bright centre), dust (True or a mote count), id (stable key)."""

    def __init__(self, x, y, radius=200, color="#ffffff", intensity=1.0, **kw):
        self.x, self.y, self.radius, self.color, self.intensity = x, y, radius, color, intensity
        for _k, _v in kw.items():
            setattr(self, _k, _v)

    def _disp(self):
        d = dict(self.__dict__)
        if 'cone' in d and d['cone'] is not None:
            d['cone'] = list(d['cone'])
        return d


class LightMap(Displayable):
    """Darkness with lights cut out of it, drawn over whatever is under it.
    LightMap(lights=[Light(...)], ambient="#07000b", dark=0.8, occluders=[(x0, y0, x1, y1, bleed)], blur=8, xysize=None)
    Put it inside a viewport to light a scrolling world; light.js loads the first time one is drawn."""

    def __init__(self, lights=(), ambient="#000000", dark=0.75, occluders=(), blur=8, xysize=None):
        self.k = 'lightmap'
        self.lights = [l._disp() if hasattr(l, '_disp') else l for l in lights if l is not None]
        self.ambient, self.dark, self.blur, self.xysize = ambient, dark, blur, xysize
        self.occluders = [list(o) + [0] * (5 - len(o)) for o in occluders]


class Gradient(Displayable):
    """Vertical or horizontal gradient: Gradient(((0,'#0000'),(1,'#000c')), xysize=(1280,260))."""

    def __init__(self, stops, xysize=None, vertical=True):
        self.k = 'grad'
        self.stops = [list(s) for s in stops]
        self.xysize = xysize
        self.vertical = vertical


class Text(Displayable):
    def __init__(self, text, **kw):
        self.k = 'text'
        self.v = _interp(text)
        for _k, _v in kw.items():
            setattr(self, _k, _v)


class Transform(Displayable):
    def __init__(self, child, **kw):
        self.k = 'xf'
        self.child = _disp_of(child)
        for _k, _v in kw.items():
            setattr(self, _k, _v)


def _disp_of(d):
    if isinstance(d, str):
        return d
    if hasattr(d, '_disp'):
        return d._disp()
    return d


def _img(name, d):
    _images[name] = _disp_of(d)


def _images_json():
    return _js(_images)


# ---------------------------------------------------------------- transitions
class Dissolve:
    def __init__(self, t=0.5):
        self.t = t

    def _disp(self):
        return {'k': 'dissolve', 't': self.t}


class Fade:
    def __init__(self, out_time=0.5, hold_time=0.0, in_time=0.5, color='#000'):
        self.o, self.h, self.i, self.color = out_time, hold_time, in_time, color

    def _disp(self):
        return {'k': 'fade', 'o': self.o, 'h': self.h, 'i': self.i, 'color': self.color}


class Shake:
    def __init__(self, t=0.5, amp=14, axis='v'):
        self.t, self.amp, self.axis = t, amp, axis

    def _disp(self):
        return {'k': 'shake', 't': self.t, 'amp': self.amp, 'axis': self.axis}


class Glitch:
    """A mosh-style transition: the old frame tears into the new one."""

    def __init__(self, t=0.5, strength=1.0):
        self.t, self.strength = t, strength

    def _disp(self):
        return {'k': 'glitch', 't': self.t, 's': self.strength}


class MultipleTransition:
    def __init__(self, *ts):
        self.ts = ts

    def _disp(self):
        return {'k': 'multi', 'list': [_plain(t) for t in self.ts]}


dissolve = Dissolve(0.5)
fade = Fade(0.5, 0, 0.5)
flash = Fade(0.1, 0.0, 0.5, color='#fff')
redflash = Fade(0.1, 0.0, 0.7, color='#e01030')
vpunch = Shake(0.5, 14, 'v')
hpunch = Shake(0.5, 14, 'h')
glitch = Glitch(0.6)
pixellate = Dissolve(0.5)


def _trans(expr):
    if expr is None or expr == 'None':
        return 'null'
    return _js(eval(expr, _store))


# ---------------------------------------------------------------- actions
class Action:
    def __call__(self):
        pass

    def get_sensitive(self):
        return True

    def get_selected(self):
        return False


class NullAction(Action):
    pass


class Jump(Action):
    def __init__(self, label):
        self.label = label

    def __call__(self):
        raise _Ctl('jump', self.label)


class Call(Action):
    def __init__(self, label):
        self.label = label

    def __call__(self):
        raise _Ctl('call', self.label)


class Return(Action):
    def __init__(self, value=None):
        self.value = value

    def __call__(self):
        raise _Ctl('return', self.value)


class SetVariable(Action):
    def __init__(self, name, value):
        self.name, self.value = name, value

    def __call__(self):
        _store[self.name] = self.value

    def get_selected(self):
        return _store.get(self.name) == self.value


class ToggleVariable(Action):
    def __init__(self, name, a=True, b=False):
        self.name, self.a, self.b = name, a, b

    def __call__(self):
        _store[self.name] = self.b if _store.get(self.name) == self.a else self.a

    def get_selected(self):
        return _store.get(self.name) == self.a


class SetDict(Action):
    def __init__(self, d, k, v):
        self.d, self.k, self.v = d, k, v

    def __call__(self):
        self.d[self.k] = self.v

    def get_selected(self):
        return self.d.get(self.k) == self.v


class ToggleDict(Action):
    def __init__(self, d, k, a=True, b=False):
        self.d, self.k, self.a, self.b = d, k, a, b

    def __call__(self):
        self.d[self.k] = self.b if self.d.get(self.k) == self.a else self.a

    def get_selected(self):
        return self.d.get(self.k) == self.a


class SetScreenVariable(Action):
    def __init__(self, name, value):
        self.name, self.value, self.scope = name, value, _cur_scope

    def __call__(self):
        self.scope[self.name] = self.value

    def get_selected(self):
        return self.scope.get(self.name) == self.value


class ToggleScreenVariable(Action):
    def __init__(self, name, a=True, b=False):
        self.name, self.a, self.b, self.scope = name, a, b, _cur_scope

    def __call__(self):
        self.scope[self.name] = self.b if self.scope.get(self.name) == self.a else self.a

    def get_selected(self):
        return self.scope.get(self.name) == self.a


class Function(Action):
    def __init__(self, f, *args, **kw):
        self.f, self.args, self.kw = f, args, kw

    def __call__(self):
        return self.f(*self.args, **self.kw)


class Show(Action):
    def __init__(self, screen, **kw):
        self.screen, self.kw = screen, kw

    def __call__(self):
        renpy.show_screen(self.screen, **self.kw)

    def get_selected(self):
        return self.screen in _shown_screens


class Hide(Action):
    def __init__(self, screen=None):
        self.screen = screen

    def __call__(self):
        renpy.hide_screen(self.screen or _cur_screen_name)


class ToggleScreen(Action):
    def __init__(self, screen, **kw):
        self.screen, self.kw = screen, kw

    def __call__(self):
        if self.screen in _shown_screens:
            renpy.hide_screen(self.screen)
        else:
            renpy.show_screen(self.screen, **self.kw)

    def get_selected(self):
        return self.screen in _shown_screens


class ShowMenu(Action):
    def __init__(self, screen='save', **kw):
        self.screen, self.kw = screen, kw

    def __call__(self):
        _screen_args[self.screen] = self.kw
        _cmd('show_menu', self.screen)


class Notify(Action):
    def __init__(self, msg):
        self.msg = msg

    def __call__(self):
        renpy.notify(self.msg)


class Play(Action):
    def __init__(self, channel, f, **kw):
        self.channel, self.f, self.kw = channel, f, kw

    def __call__(self):
        _cmd('play', self.channel, self.f, self.kw)


class Stop(Action):
    def __init__(self, channel, fadeout=0):
        self.channel, self.fadeout = channel, fadeout

    def __call__(self):
        _cmd('stop', self.channel, {'fadeout': self.fadeout})


class If(Action):
    def __init__(self, cond, true=None, false=None):
        self.cond, self.t, self.f = cond, true, false

    def __call__(self):
        _run(self.t if self.cond else self.f)


class _EngineAction(Action):
    def __init__(self, op, *args):
        self.op, self.args = op, args

    def __call__(self):
        _cmd(self.op, *self.args)


def FileSave(slot):
    return _EngineAction('save', slot)


def FileLoad(slot):
    return _EngineAction('load', slot)


def FileDelete(slot):
    return _EngineAction('delete_save', slot)


def QuickSave():
    return _EngineAction('save', 'quick')


def QuickLoad():
    return _EngineAction('load', 'quick')


def Rollback():
    return _EngineAction('rollback')


def Skip():
    return _EngineAction('skip')


def Auto():
    return _EngineAction('auto')


def HideInterface():
    return _EngineAction('hide_ui')


def MainMenu():
    return _EngineAction('main_menu')


def Start(label='start'):
    return _EngineAction('start', label)


def Quit():
    return _EngineAction('quit')


def ToggleFullscreen():
    return _EngineAction('fullscreen')


class Preference(Action):
    """Preference('text speed', 60) / Preference('auto-forward', 'toggle') / Preference('music volume', .5)."""
    MAP = {'text speed': 'text_cps', 'auto-forward time': 'auto_delay', 'music volume': 'music', 'sound volume': 'sfx',
           'voice volume': 'voice', 'skip': 'skip_unseen', 'effects': 'fx'}

    def __init__(self, name, value):
        self.name, self.value = name, value

    def __call__(self):
        k = self.MAP.get(self.name, self.name)
        if self.value == 'toggle':
            setattr(preferences, k, not getattr(preferences, k))
        else:
            setattr(preferences, k, self.value)
        _cmd('prefs')

    def get_selected(self):
        k = self.MAP.get(self.name, self.name)
        v = getattr(preferences, k, None)
        return v is True if self.value == 'toggle' else v == self.value


def _run(a):
    if a is None:
        return
    if isinstance(a, (list, tuple)):
        for x in a:
            _run(x)
        return
    a()


def _A(a):
    if a is None:
        return -1
    _ACTS.append(a)
    return len(_ACTS) - 1


def _sens(a):
    if a is None:
        return True
    if isinstance(a, (list, tuple)):
        return all(_sens(x) for x in a)
    return a.get_sensitive() if hasattr(a, 'get_sensitive') else True


def _sel(a):
    if a is None:
        return False
    if isinstance(a, (list, tuple)):
        return any(_sel(x) for x in a)
    return a.get_selected() if hasattr(a, 'get_selected') else False


def _guard(f, *args):
    """Run f; turn control exceptions into a JSON reply the VM understands."""
    try:
        r = f(*args)
        return _js({'ok': 1, 'v': r})
    except _Ctl as c:
        if c.kind == 'say':
            return _js({'ctl': 'say', 'arg': [_say(c.arg[0], c.arg[1])]})
        return _js({'ctl': c.kind, 'arg': c.arg})


def _act(i):
    return _guard(lambda: _run(_ACTS[i]) if 0 <= i < len(_ACTS) else None)


# ---------------------------------------------------------------- statements the VM delegates
def _exec(code):
    return _guard(lambda: exec(code, _store))


def _eval(expr):
    return _guard(lambda: eval(expr, _store))


def _evals(exprs):
    return _js([eval(e, _store) for e in exprs])


def _cond(expr):
    return 1 if eval(expr, _store) else 0


def _menu(items):
    """items: [[caption, cond_or_None], ...] -> indices of visible items; sets choice screen args."""
    vis = []
    caps = []
    if isinstance(items, str):
        items = json.loads(items)
    for i, (cap, cond) in enumerate(items):
        if cond is None or eval(cond, _store):
            vis.append(i)
            caps.append(MenuItem(_interp(cap), Return(i)))
    _screen_args['choice'] = {'items': caps}
    return _js(vis)


class MenuItem:
    def __init__(self, caption, action):
        self.caption, self.action = caption, action


# ---------------------------------------------------------------- screens
def _screen(name, fn, modal=False, zorder=0, tag=None, layer='screens'):
    _SCREENS[name] = [fn, {'modal': modal, 'zorder': zorder, 'tag': tag or name, 'layer': layer}]


def _screen_info():
    return _js({k: v[1] for k, v in _SCREENS.items()})


def _args(*a, **kw):
    """Arguments of `show screen x(...)` / `call screen x(...)`, positional ones kept in order."""
    if a:
        kw['__pos'] = list(a)
    return kw


def _set_screen_args(name, args_json):
    _screen_args[name] = _revive(json.loads(args_json)) if args_json else {}


def _render(names_json):
    """Render the shown screens (in order). Returns {name: [nodes]}; resets the action table."""
    global _ACTS, _cur_scope, _cur_screen_name
    _ACTS = []
    names = json.loads(names_json)
    _shown_screens.clear()
    for n in names:
        _shown_screens.add(n)
    out = {}
    for n in names:
        if n not in _SCREENS:
            continue
        sc = _scopes.get(n)
        if sc is None:
            sc = _scopes[n] = {}
        _cur_scope = sc
        _cur_screen_name = n
        try:
            kw = dict(_screen_args.get(n, {}))
            pos = kw.pop('__pos', [])
            out[n] = _SCREENS[n][0](sc, *pos, **kw)
        except Exception as e:
            out[n] = [{'k': 'text', 'v': 'screen %s: %s' % (n, e), 'color': '#f44', 'size': 20}]
    _cur_scope = None
    return _js(out)


def _forget_scope(name):
    if name in _scopes:
        del _scopes[name]
    if name in _screen_args and name != 'choice':
        pass


_cur_screen_name = None


# ---------------------------------------------------------------- save / rollback
def _store_dump():
    d = {}
    for k in _defaults:
        d[k] = _plain(_store.get(k))
    return _js(d)


def _store_load(s):
    d = _revive(json.loads(s))
    for k, v in d.items():
        _store[k] = v


def _default(name, value):
    if name not in _defaults:
        _defaults.append(name)
    _store[name] = value


def _seen(label):
    persistent._seen_labels.add(label)


def _is_seen(label):
    return 1 if label in persistent._seen_labels else 0


# ---------------------------------------------------------------- config / gui namespaces
class _NS:
    pass


config = _NS()
config.name = 'vn-engine game'
config.screen_width = 1280
config.screen_height = 720
config.atlas = None
config.audio_pack = None
config.fonts = {}
config.main_menu_music = None
config.default_text_cps = 45
config.history_length = 200
config.start_label = 'start'
config.main_menu_label = None
gui = _NS()
gui.font = 'sans-serif'
gui.text_size = 30
gui.name_size = 26
gui.accent = '#ff7eb6'
gui.text_color = '#ffffff'
gui.idle_color = '#bbbbbb'
gui.hover_color = '#ff7eb6'
gui.selected_color = '#ffffff'
gui.insensitive_color = '#66666688'
gui.button_bg = '#00000088'

_history = []


def _history_add(who, what):
    _history.append([who, what])
    if len(_history) > config.history_length:
        _history.pop(0)


def _history_pop():
    if _history:
        _history.pop()


def _set_return(s):
    _store['_return'] = _revive(json.loads(s))


def _config_json():
    return _js({k: v for k, v in config.__dict__.items()})


_return = None
_skipping = False
on_rollback = None
on_skip = None
_last_say_who = None


def _slots():
    """Save-slot metadata from the JS side: {slot: {when, label, text, thumb}}."""
    try:
        import js
        return json.loads(js.JSON.stringify(js.VN.slots()))
    except Exception:
        return {}


def _slot_time(ms):
    try:
        import js
        return str(js.Date.new(ms).toLocaleString())
    except Exception:
        return ''


def FilePage(n):
    return SetVariable('_file_page', n)


_file_page = 1
