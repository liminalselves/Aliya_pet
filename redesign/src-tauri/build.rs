fn main() {
    println!("cargo:rerun-if-changed=icons/tray.ico");
    tauri_build::build()
}
