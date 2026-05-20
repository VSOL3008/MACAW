use crate::windows::MainWindow;
use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const SHOW: &str = "show";
const HIDE: &str = "hide";
const QUIT: &str = "quit";

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW, "Open MACAW", true, None::<&str>)?;
    let hidden = MenuItem::with_id(app, HIDE, "Hide to tray", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit MACAW", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hidden, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("MACAW")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW => open(app),
            HIDE => hide(app),
            QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                open(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MainWindow::LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    let _ = MainWindow::create(app);
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MainWindow::LABEL) {
        let _ = window.hide();
    }
}
