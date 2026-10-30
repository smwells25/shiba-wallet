package expo.modules.shibanavigationbar

import android.os.Build
import android.view.View
import android.view.WindowInsetsController
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Sets the light or dark appearance of the activity window's navigation bar
 * (pass p23-navbar).
 *
 * expo-navigation-bar's setStyle goes through androidx.core's
 * WindowInsetsControllerCompat built with a Window, which on API 30-34 writes
 * only the deprecated View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR flag. Android
 * ignores that flag once the window's appearance has been set through
 * WindowInsetsController.setSystemBarsAppearance (the window is then
 * APPEARANCE_CONTROLLED), which React Native's StatusBar does on API 31 and
 * up (react-native 0.86.3 WindowUtil.kt setStatusBarStyle, lines 99-113,
 * `SDK_INT > R`).
 *
 * So this module uses the same switch point as React Native's status bar:
 * on API 31 and up it calls setSystemBarsAppearance and changes only the
 * navigation-bar bit, keeping every other appearance bit; on API 26-30 it
 * writes the deprecated view flag, which React Native's status bar also
 * writes there, so the two never disagree about which mechanism the window
 * follows. API 24-25 have no light navigation-bar appearance.
 *
 * setNavigationBarAppearance(light): light = true asks for a light bar with
 * dark buttons, false for a dark bar with light buttons. It resolves to the
 * path that ran: "platform-api", "compat-flag" or "unsupported". Only the
 * activity's own window is changed, not dialog windows.
 */
class ShibaNavigationBarModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShibaNavigationBar")

    AsyncFunction("setNavigationBarAppearance") { light: Boolean ->
      val window = appContext.throwingActivity.window
      if (Build.VERSION.SDK_INT > Build.VERSION_CODES.R) {
        val controller = window.insetsController
          ?: throw IllegalStateException("The window has no insets controller yet")
        val bit = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        controller.setSystemBarsAppearance(if (light) bit else 0, bit)
        return@AsyncFunction "platform-api"
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        @Suppress("DEPRECATION")
        val flag = View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val decorView = window.decorView
        @Suppress("DEPRECATION")
        val flags = decorView.systemUiVisibility
        @Suppress("DEPRECATION")
        decorView.systemUiVisibility = if (light) flags or flag else flags and flag.inv()
        return@AsyncFunction "compat-flag"
      }
      return@AsyncFunction "unsupported"
    }.runOnQueue(Queues.MAIN)
  }
}
