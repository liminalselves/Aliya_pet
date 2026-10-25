fn main() {
    for icon in [
        "icons/tray.ico",
        "icons/icon.png",
        "icons/icon.icns",
        "icons/tray-template.png",
        "icons/tray-template@2x.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }
    tauri_build::build()
}
