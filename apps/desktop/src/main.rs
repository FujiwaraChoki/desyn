//! The `desyn` binary. Feature modules register themselves here (see `ARCHITECTURE.md`, "Extension API"):
//! add `Box::new(my_module::install)` to the installer list.

fn main() {
    desyn_desktop::ui::run(desyn_desktop::features::installers());
}
