// Root project — no plugins applied here; subprojects pick them via settings.
tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
