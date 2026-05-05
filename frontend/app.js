(function () {
    'use strict';

    const landing = document.getElementById('landing');
    const terminalView = document.getElementById('terminal-view');
    const settingsPage = document.getElementById('settings-page');
    const chooseBtn = document.getElementById('choose-dir-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const settingsClose = document.getElementById('settings-close');
    const terminalContainer = document.getElementById('terminal');

    let term = null;
    let fitAddon = null;
    let bridgeReady = false;

    // --- Wait for pywebview bridge ---
    function waitForBridge(timeoutMs, callback) {
        const start = Date.now();
        const check = () => {
            if (window.pywebview && window.pywebview.api) {
                bridgeReady = true;
                callback(true);
            } else if (Date.now() - start > timeoutMs) {
                callback(false);
            } else {
                setTimeout(check, 50);
            }
        };
        check();
    }

    // --- Landing Page ---
    if (chooseBtn) {
        chooseBtn.addEventListener('click', () => {
            waitForBridge(3000, (ready) => {
                if (!ready) {
                    alert('Python bridge not available');
                    return;
                }
                window.pywebview.api.pick_directory()
                    .then((path) => {
                        if (path) {
                            showTerminal(path);
                        }
                    })
                    .catch((err) => {
                        console.error('Failed to pick directory:', err);
                    });
            });
        });
    }

    // --- Settings Page ---
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            showSettings();
        });
    }

    if (settingsClose) {
        settingsClose.addEventListener('click', () => {
            hideSettings();
        });
    }

    function showSettings() {
        if (landing) landing.classList.add('hidden');
        if (settingsPage) settingsPage.classList.add('active');
        loadSettingsTab('setup');
    }

    function hideSettings() {
        if (settingsPage) settingsPage.classList.remove('active');
        if (landing) landing.classList.remove('hidden');
    }

    // --- Settings Tabs ---
    const tabs = document.querySelectorAll('.settings-tab');
    const panels = document.querySelectorAll('.tab-panel');

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            tabs.forEach((t) => t.classList.remove('active'));
            panels.forEach((p) => p.classList.remove('active'));
            tab.classList.add('active');
            const panel = document.getElementById('tab-' + target);
            if (panel) panel.classList.add('active');
            loadSettingsTab(target);
        });
    });

    function loadSettingsTab(tabName) {
        if (!window.pywebview || !window.pywebview.api) return;

        if (tabName === 'config') {
            window.pywebview.api.get_opencode_config()
                .then((res) => {
                    const editor = document.getElementById('config-editor');
                    if (editor && res.success) {
                        editor.value = res.content;
                    } else if (editor) {
                        editor.value = '';
                        showStatus('config-status', res.error, true);
                    }
                })
                .catch((err) => {
                    showStatus('config-status', String(err), true);
                });
        } else if (tabName === 'updater') {
            window.pywebview.api.get_current_version()
                .then((ver) => {
                    const el = document.getElementById('current-version');
                    if (el) el.textContent = ver;
                });
        }
    }

    function showStatus(id, message, isError) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = message;
        el.className = isError ? 'error' : 'success';
    }

    // --- Setup Tab ---
    const setupRunBtn = document.getElementById('setup-run-btn');
    if (setupRunBtn) {
        setupRunBtn.addEventListener('click', () => {
            const input = document.getElementById('api-key-input');
            const apiKey = input ? input.value : '';
            showStatus('setup-status', 'Running setup...', false);
            window.pywebview.api.setup_configs(apiKey)
                .then((res) => {
                    if (res.success) {
                        if (res.warning) {
                            showStatus('setup-status', res.warning, true);
                        } else {
                            showStatus('setup-status', 'Setup complete!', false);
                        }
                    } else {
                        showStatus('setup-status', res.error, true);
                    }
                })
                .catch((err) => {
                    showStatus('setup-status', String(err), true);
                });
        });
    }

    // --- Config Tab ---
    const configSaveBtn = document.getElementById('config-save-btn');
    if (configSaveBtn) {
        configSaveBtn.addEventListener('click', () => {
            const editor = document.getElementById('config-editor');
            const content = editor ? editor.value : '';
            showStatus('config-status', 'Saving...', false);
            window.pywebview.api.save_opencode_config(content)
                .then((res) => {
                    if (res.success) {
                        showStatus('config-status', 'Saved!', false);
                    } else {
                        showStatus('config-status', res.error, true);
                    }
                })
                .catch((err) => {
                    showStatus('config-status', String(err), true);
                });
        });
    }

    const configReloadBtn = document.getElementById('config-reload-btn');
    if (configReloadBtn) {
        configReloadBtn.addEventListener('click', () => {
            loadSettingsTab('config');
            showStatus('config-status', 'Reloaded.', false);
        });
    }

    // --- Updater Tab ---
    const checkUpdateBtn = document.getElementById('check-update-btn');
    if (checkUpdateBtn) {
        checkUpdateBtn.addEventListener('click', () => {
            showStatus('updater-status', 'Checking...', false);
            window.pywebview.api.check_for_updates()
                .then((res) => {
                    if (res.success) {
                        if (res.has_update) {
                            showStatus('updater-status', `Update available: v${res.latest_version}`, false);
                        } else {
                            showStatus('updater-status', 'You are on the latest version.', false);
                        }
                    } else {
                        showStatus('updater-status', res.error, true);
                    }
                })
                .catch((err) => {
                    showStatus('updater-status', String(err), true);
                });
        });
    }

    const updateConfigsBtn = document.getElementById('update-configs-btn');
    if (updateConfigsBtn) {
        updateConfigsBtn.addEventListener('click', () => {
            showStatus('updater-status', 'Downloading configs...', false);
            window.pywebview.api.update_configs_from_github()
                .then((res) => {
                    if (res.success) {
                        let msg = res.message;
                        if (res.warnings && res.warnings.length > 0) {
                            msg += ' Warnings:\n' + res.warnings.join('\n');
                        }
                        showStatus('updater-status', msg, false);
                    } else {
                        showStatus('updater-status', res.error, true);
                    }
                })
                .catch((err) => {
                    showStatus('updater-status', String(err), true);
                });
        });
    }

    // --- Show Terminal View ---
    function showTerminal(dir) {
        if (landing) landing.classList.add('hidden');
        if (settingsPage) settingsPage.classList.remove('active');
        if (terminalView) terminalView.classList.add('active');
        initTerminal(dir);
    }

    // --- Terminal Setup ---
    function initTerminal(dir) {
        if (!terminalContainer) return;

        if (typeof Terminal === 'undefined') {
            terminalContainer.innerHTML = '<div style="color:#c0c0c0;padding:20px;font-family:monospace;">Error: Terminal library failed to load.</div>';
            return;
        }

        term = new Terminal({
            theme: {
                background: '#0a0a0a',
                foreground: '#b8b8b8',
                cursor: '#c0c0c0',
                selectionBackground: '#4a4a4a',
                black: '#0a0a0a',
                red: '#b0b0b0',
                green: '#a0a0a0',
                yellow: '#c0c0c0',
                blue: '#909090',
                magenta: '#b0b0b0',
                cyan: '#a0a0a0',
                white: '#e0e0e0',
                brightBlack: '#4a4a4a',
                brightRed: '#d0d0d0',
                brightGreen: '#c0c0c0',
                brightYellow: '#e0e0e0',
                brightBlue: '#b0b0b0',
                brightMagenta: '#d0d0d0',
                brightCyan: '#c0c0c0',
                brightWhite: '#ffffff'
            },
            fontFamily: '"Cascadia Mono", "Consolas", "Lucida Console", "Courier New", monospace',
            fontSize: 14,
            letterSpacing: 0,
            lineHeight: 1.0,
            cursorBlink: true,
            cursorStyle: 'block',
            scrollback: 10000
        });

        term.open(terminalContainer);
        term.focus();

        if (typeof FitAddon !== 'undefined') {
            fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
        }

        // --- Keyboard copy/paste shortcuts ---
        term.attachCustomKeyEventHandler((e) => {
            // Ctrl+C with selection: copy, don't send SIGINT
            if (e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
                navigator.clipboard.writeText(term.getSelection()).catch(() => {});
                term.clearSelection();
                return false;
            }
            // Ctrl+Shift+C: always copy
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
                if (term.hasSelection()) {
                    navigator.clipboard.writeText(term.getSelection()).catch(() => {});
                    term.clearSelection();
                }
                return false;
            }
            // Block xterm's built-in paste (Ctrl+V / Ctrl+Shift+V / Shift+Insert)
            // Our DOM paste event listener handles pasting instead (no double-paste)
            if ((e.ctrlKey && e.code === 'KeyV') || (e.shiftKey && e.code === 'Insert')) {
                return false;
            }
            return true;
        });

        // --- Paste: DOM event avoids clipboard permission prompt & double-paste ---
        term.element.addEventListener('paste', (e) => {
            const text = e.clipboardData.getData('text');
            if (text && window.pywebview && window.pywebview.api) {
                e.preventDefault();
                e.stopPropagation();
                try { window.pywebview.api.send_input(text); } catch (err) {}
            }
        });

        // --- Right-click copy context menu ---
        terminalContainer.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const selection = term.getSelection();
            if (selection) {
                navigator.clipboard.writeText(selection).catch(() => {});
                // Flash a brief indicator
                const indicator = document.createElement('div');
                indicator.textContent = 'Copied!';
                indicator.style.cssText = 'position:fixed;top:' + e.clientY + 'px;left:' + e.clientX + 'px;background:#4a4a4a;color:#e0e0e0;padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace;pointer-events:none;z-index:9999;';
                document.body.appendChild(indicator);
                setTimeout(() => indicator.remove(), 800);
            }
        });

        function syncSize() {
            if (fitAddon) {
                fitAddon.fit();
            }
            if (window.pywebview && window.pywebview.api) {
                try {
                    window.pywebview.api.resize_terminal(term.cols, term.rows);
                } catch (e) {
                    // ignore
                }
            }
        }

        window.addEventListener('resize', syncSize);

        // ResizeObserver: fires when container actually changes size (reliable)
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(syncSize).observe(terminalContainer);
        } else {
            // Fallback: poll until container has real dimensions
            var pollTimer = setInterval(function () {
                if (terminalContainer.offsetWidth > 0 && terminalContainer.offsetHeight > 0) {
                    syncSize();
                    clearInterval(pollTimer);
                }
            }, 50);
            setTimeout(function () { clearInterval(pollTimer); syncSize(); }, 3000);
        }

        // Staggered resync on first PTY output (TUI initializes over a few seconds)
        var firstOutput = true;
        var tuiReady = false;
        window.writeToTerm = (data) => {
            if (term) {
                term.write(data);
                if (firstOutput) {
                    firstOutput = false;
                    [500, 1200, 2500, 5000].forEach(function (d) {
                        setTimeout(function () { syncSize(); if (d >= 2500) tuiReady = true; }, d);
                    });
                }
            }
        };

        // Click in terminal after TUI loads triggers a re-fit
        terminalContainer.addEventListener('mousedown', function () {
            if (tuiReady) {
                tuiReady = false;
                setTimeout(syncSize, 0);
            }
        });

        // Keypress in terminal after TUI loads triggers a re-fit
        var keyFitUsed = false;
        terminalContainer.addEventListener('keydown', function () {
            if (tuiReady && !keyFitUsed) {
                keyFitUsed = true;
                setTimeout(syncSize, 0);
            }
        });

        term.onData((data) => {
            if (window.pywebview && window.pywebview.api) {
                try {
                    window.pywebview.api.send_input(data);
                } catch (e) {
                    // ignore
                }
            }
        });

        term.writeln('');
        term.writeln('Monolith Terminal');
        term.writeln('Directory: ' + dir);
        term.writeln('Starting opencode...');
        term.writeln('');

        if (!window.pywebview || !window.pywebview.api) {
            term.writeln('Error: Python bridge not available.');
            return;
        }

        window.pywebview.api.start_opencode(dir)
            .then((success) => {
                if (!success) {
                    term.writeln('');
                    term.writeln('Failed to start opencode. Check that it is installed and in your PATH.');
                }
            })
            .catch((err) => {
                term.writeln('');
                term.writeln('Error starting opencode: ' + err);
            });
    }
})();
