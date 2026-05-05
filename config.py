import json
import os


CONFIG_DIR = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'Monolith')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.json')

_DEFAULTS = {
    'last_directory': '',
    'window_width': 900,
    'window_height': 600,
    'window_maximized': False,
}


def _load():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return {**_DEFAULTS, **json.load(f)}
        except Exception:
            pass
    return dict(_DEFAULTS)


def get(key):
    return _load().get(key, _DEFAULTS.get(key))


def set(key, value):
    config = _load()
    config[key] = value
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2)
