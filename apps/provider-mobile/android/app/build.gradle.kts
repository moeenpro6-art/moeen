import groovy.json.JsonSlurper
import java.io.File

plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.moeen.moeen_provider"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own Application ID (https://flutter.dev/to/review-gradle-config).
        applicationId = "com.moeen.moeen_provider"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

/**
 * This app must clear a stale flutter_foreground_task stopWithTask preference
 * before plugin initialization. The preference API is plugin-internal, so fail
 * every Android build when the resolved plugin no longer exposes the exact
 * storage contract verified here.
 */
val verifyFlutterForegroundTaskStopWithTaskContract =
    tasks.register("verifyFlutterForegroundTaskStopWithTaskContract") {
        group = "verification"
        description =
            "Verifies the resolved flutter_foreground_task source matches MainActivity's " +
                "stopWithTask preference workaround."

        doLast {
            val contractVersion = "11.0.1"
            val expectedPrefix =
                providers.gradleProperty("foregroundTaskContractPrefix")
                    .orElse("com.pravera.flutter_foreground_task.prefs.")
                    .get()
            val expectedOptionsSuffix =
                providers.gradleProperty("foregroundTaskContractOptionsSuffix")
                    .orElse("FOREGROUND_TASK_OPTIONS")
                    .get()
            val expectedStopWithTaskKey =
                providers.gradleProperty("foregroundTaskContractStopWithTaskKey")
                    .orElse("stopWithTask")
                    .get()
            val expectedOptionsPreferences = "$expectedPrefix$expectedOptionsSuffix"

            val appRoot = rootProject.projectDir.parentFile
            val pubspec = appRoot.resolve("pubspec.yaml")
            val lockfile = appRoot.resolve("pubspec.lock")
            val resolvedPlugins = appRoot.resolve(".flutter-plugins-dependencies")
            check(pubspec.isFile) { "Missing pubspec.yaml at ${pubspec.absolutePath}." }
            check(lockfile.isFile) { "Missing pubspec.lock at ${lockfile.absolutePath}." }
            check(resolvedPlugins.isFile) {
                "Missing Flutter resolved-plugin metadata at ${resolvedPlugins.absolutePath}. " +
                    "Run flutter pub get before the Android build."
            }

            val declaredVersion =
                Regex("""(?m)^  flutter_foreground_task:\s*(\S+)\s*$""")
                    .find(pubspec.readText())
                    ?.groupValues
                    ?.get(1)
            check(declaredVersion == contractVersion) {
                "flutter_foreground_task must be declared exactly as $contractVersion; found $declaredVersion."
            }

            val lockLines = lockfile.readLines()
            val lockStart = lockLines.indexOfFirst { it == "  flutter_foreground_task:" }
            check(lockStart >= 0) { "flutter_foreground_task is absent from pubspec.lock." }
            val lockEndRelative =
                lockLines
                    .drop(lockStart + 1)
                    .indexOfFirst { it.startsWith("  ") && !it.startsWith("    ") }
            val lockEnd =
                if (lockEndRelative < 0) lockLines.size else lockStart + 1 + lockEndRelative
            val lockEntry = lockLines.subList(lockStart + 1, lockEnd)
            check(lockEntry.any { it.trim() == "version: \"$contractVersion\"" }) {
                "pubspec.lock must resolve flutter_foreground_task to $contractVersion."
            }

            @Suppress("UNCHECKED_CAST")
            val resolvedMetadata = JsonSlurper().parse(resolvedPlugins) as? Map<*, *>
                ?: error("Flutter resolved-plugin metadata is not a JSON object.")
            val pluginsByPlatform = resolvedMetadata["plugins"] as? Map<*, *>
                ?: error("Flutter resolved-plugin metadata has no plugins map.")
            val androidPlugins = pluginsByPlatform["android"] as? List<*>
                ?: error("Flutter resolved-plugin metadata has no Android plugin list.")
            val foregroundTaskPlugin =
                androidPlugins
                    .mapNotNull { it as? Map<*, *> }
                    .singleOrNull { it["name"] == "flutter_foreground_task" }
                    ?: error("Resolved Android plugins do not contain exactly one flutter_foreground_task entry.")
            val resolvedPluginPath = foregroundTaskPlugin["path"] as? String
                ?: error("Resolved flutter_foreground_task entry has no source path.")
            val resolvedPlugin = File(resolvedPluginPath)
            check(resolvedPlugin.isDirectory) {
                "Resolved flutter_foreground_task source is unavailable at ${resolvedPlugin.absolutePath}."
            }

            val pluginPubspec = resolvedPlugin.resolve("pubspec.yaml")
            check(pluginPubspec.isFile) {
                "Resolved flutter_foreground_task source has no pubspec.yaml at ${pluginPubspec.absolutePath}."
            }
            val pluginPubspecText = pluginPubspec.readText()
            check(Regex("""(?m)^name:\s*flutter_foreground_task\s*$""").containsMatchIn(pluginPubspecText)) {
                "Resolved Android plugin path is not flutter_foreground_task."
            }
            check(Regex("""(?m)^version:\s*$contractVersion\s*$""").containsMatchIn(pluginPubspecText)) {
                "Resolved flutter_foreground_task source must be version $contractVersion."
            }

            val kotlinSourceRoot =
                resolvedPlugin.resolve(
                    "android/src/main/kotlin/com/pravera/flutter_foreground_task",
                )
            val preferencesKey = kotlinSourceRoot.resolve("PreferencesKey.kt")
            val taskOptions = kotlinSourceRoot.resolve("models/ForegroundTaskOptions.kt")
            check(preferencesKey.isFile) {
                "Resolved plugin has no PreferencesKey.kt at ${preferencesKey.absolutePath}."
            }
            check(taskOptions.isFile) {
                "Resolved plugin has no ForegroundTaskOptions.kt at ${taskOptions.absolutePath}."
            }

            val preferencesKeyText = preferencesKey.readText()
            check(
                Regex(
                    """private\s+const\s+val\s+prefix\s*=\s*"${Regex.escape(expectedPrefix)}""",
                ).containsMatchIn(preferencesKeyText),
            ) {
                "Resolved plugin no longer defines the expected preference prefix $expectedPrefix."
            }
            check(
                Regex(
                    """val\s+FOREGROUND_TASK_OPTIONS_PREFS\s*=\s*prefix\s*\+\s*"${Regex.escape(expectedOptionsSuffix)}""",
                ).containsMatchIn(preferencesKeyText),
            ) {
                "Resolved plugin no longer composes FOREGROUND_TASK_OPTIONS_PREFS from the expected suffix $expectedOptionsSuffix."
            }
            check(
                Regex(
                    """const\s+val\s+STOP_WITH_TASK\s*=\s*"${Regex.escape(expectedStopWithTaskKey)}""",
                ).containsMatchIn(preferencesKeyText),
            ) {
                "Resolved plugin no longer defines STOP_WITH_TASK as $expectedStopWithTaskKey."
            }

            val taskOptionsText = taskOptions.readText()
            check(
                Regex(
                    """getSharedPreferences\s*\(\s*PrefsKey\.FOREGROUND_TASK_OPTIONS_PREFS\s*,\s*Context\.MODE_PRIVATE\s*\)""",
                    setOf(RegexOption.DOT_MATCHES_ALL),
                ).containsMatchIn(taskOptionsText),
            ) {
                "Resolved plugin no longer reads foreground-task options from FOREGROUND_TASK_OPTIONS_PREFS private storage."
            }
            check(
                Regex(
                    """getBoolean\s*\(\s*PrefsKey\.STOP_WITH_TASK\s*,""",
                    setOf(RegexOption.DOT_MATCHES_ALL),
                ).containsMatchIn(taskOptionsText),
            ) {
                "Resolved plugin no longer reads stopWithTask through STOP_WITH_TASK from its options storage."
            }

            val pluginKotlinSources =
                kotlinSourceRoot
                    .walkTopDown()
                    .filter { it.isFile && it.extension == "kt" }
                    .joinToString("\n") { it.readText() }
            check("isSetStopWithTaskFlag" in pluginKotlinSources) {
                "Resolved plugin no longer exposes its stopWithTask task-removal check."
            }
            check(
                Regex(
                    """isSetStopWithTaskFlag\s*\([^)]*\)[\s\S]*?getSharedPreferences\s*\(\s*PrefsKey\.FOREGROUND_TASK_OPTIONS_PREFS\s*,\s*Context\.MODE_PRIVATE\s*\)[\s\S]*?getBoolean\s*\(\s*PrefsKey\.STOP_WITH_TASK\s*,\s*false\s*\)""",
                ).containsMatchIn(pluginKotlinSources),
            ) {
                "Resolved plugin no longer derives the task-removal decision from persisted stopWithTask private storage."
            }

            val mainActivity =
                project.projectDir.resolve("src/main/kotlin/com/moeen/moeen_provider/MainActivity.kt")
            check(mainActivity.isFile) { "Missing MainActivity.kt at ${mainActivity.absolutePath}." }
            val mainActivityText = mainActivity.readText()
            check(
                Regex(
                    """getSharedPreferences\s*\(\s*"${Regex.escape(expectedOptionsPreferences)}"\s*,\s*MODE_PRIVATE\s*,?\s*\)""",
                    setOf(RegexOption.DOT_MATCHES_ALL),
                ).containsMatchIn(mainActivityText),
            ) {
                "MainActivity no longer writes the resolved plugin's foreground-task options preference file."
            }
            check(
                Regex(
                    """putBoolean\s*\(\s*"${Regex.escape(expectedStopWithTaskKey)}"\s*,\s*false\s*\)""",
                ).containsMatchIn(mainActivityText),
            ) {
                "MainActivity no longer clears the resolved plugin's stopWithTask preference."
            }
            check(mainActivityText.indexOf("putBoolean") < mainActivityText.indexOf("super.onCreate")) {
                "MainActivity must clear stale stopWithTask before Flutter/plugin initialization."
            }

            logger.lifecycle(
                "flutter_foreground_task $contractVersion preference contract verified against " +
                    resolvedPlugin.absolutePath,
            )
        }
    }

tasks.named("preBuild").configure {
    dependsOn(verifyFlutterForegroundTaskStopWithTaskContract)
}
