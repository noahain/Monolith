import os
import sys
import webview

from api import Api, ensure_configs
from config import get as config_get, set as config_set


def get_resource_path(relative_path):
    """Get absolute path to resource, works for dev and for PyInstaller."""
    if getattr(sys, 'frozen', False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)


# Track window state
_window_state = {
    'maximized': False,
    'width': 900,
    'height': 600,
}


def main():
    # Download configs on first run before showing the window
    configs_ok, configs_msg = ensure_configs()
    if not configs_ok:
        print(f"Warning: {configs_msg}")

    api = Api()

    frontend_dir = get_resource_path('frontend')
    index_path = os.path.join(frontend_dir, 'index.html')

    width = config_get('window_width')
    height = config_get('window_height')
    maximized = config_get('window_maximized')

    window = webview.create_window(
        title='Monolith',
        url=index_path,
        js_api=api,
        width=width,
        height=height,
        min_size=(600, 400),
        text_select=True
    )

    api.set_window(window)
    _window_state['width'] = width
    _window_state['height'] = height
    _window_state['maximized'] = maximized

    # Event handlers
    window.events.closing += api.terminate
    window.events.closing += lambda: _on_closing(window)
    window.events.resized += _on_resized
    window.events.maximized += _on_maximized
    window.events.restored += _on_restored

    # Maximize must happen after the window is shown, not before start()
    if maximized:
        window.events.shown += window.maximize

    webview.start()


def _on_maximized():
    _window_state['maximized'] = True


def _on_restored():
    _window_state['maximized'] = False


def _on_resized(width, height):
    if not _window_state['maximized']:
        _window_state['width'] = width
        _window_state['height'] = height


def _on_closing(window):
    try:
        # If currently maximized, don't save width/height (keep previous)
        if _window_state['maximized']:
            config_set('window_maximized', True)
        else:
            config_set('window_width', _window_state['width'])
            config_set('window_height', _window_state['height'])
            config_set('window_maximized', False)
    except Exception:
        pass


if __name__ == '__main__':
    main()
