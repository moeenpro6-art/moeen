import 'package:flutter/material.dart';

/// Shared visual language for the Arabic-first customer application.
///
/// These tokens intentionally avoid gradients and decorative effects in favor
/// of clear hierarchy, semantic statuses, and generous touch targets.
abstract final class MoeenColors {
  static const primary = Color(0xFF0B6E69);
  static const primaryDark = Color(0xFF17413E);
  static const primarySoft = Color(0xFFD7F2EF);
  static const canvas = Color(0xFFF6FAF9);
  static const surface = Colors.white;
  static const border = Color(0xFFD9E4E2);
  static const mutedText = Color(0xFF66807D);
  static const success = Color(0xFF137A4A);
  static const warning = Color(0xFF9A6700);
  static const danger = Color(0xFFB42318);
  static const info = Color(0xFF175CD3);
}

abstract final class MoeenSpacing {
  static const xxs = 4.0;
  static const xs = 8.0;
  static const sm = 12.0;
  static const md = 16.0;
  static const lg = 24.0;
  static const xl = 32.0;
}

abstract final class MoeenTheme {
  static ThemeData light() {
    const scheme = ColorScheme(
      brightness: Brightness.light,
      primary: MoeenColors.primary,
      onPrimary: Colors.white,
      primaryContainer: MoeenColors.primarySoft,
      onPrimaryContainer: MoeenColors.primaryDark,
      secondary: MoeenColors.primaryDark,
      onSecondary: Colors.white,
      secondaryContainer: Color(0xFFE8F4F2),
      onSecondaryContainer: MoeenColors.primaryDark,
      tertiary: MoeenColors.info,
      onTertiary: Colors.white,
      tertiaryContainer: Color(0xFFE8F1FF),
      onTertiaryContainer: Color(0xFF0B3D91),
      error: MoeenColors.danger,
      onError: Colors.white,
      errorContainer: Color(0xFFFDECEC),
      onErrorContainer: Color(0xFF7A1212),
      surface: MoeenColors.surface,
      onSurface: MoeenColors.primaryDark,
      surfaceContainerHighest: Color(0xFFEAF2F0),
      onSurfaceVariant: MoeenColors.mutedText,
      outline: MoeenColors.border,
      outlineVariant: Color(0xFFE6EEEC),
      shadow: Color(0x240B2E2B),
      scrim: Colors.black,
      inverseSurface: MoeenColors.primaryDark,
      onInverseSurface: Colors.white,
      inversePrimary: Color(0xFF8FD8CF),
    );

    final outlinedBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(12),
      borderSide: const BorderSide(color: MoeenColors.border),
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: MoeenColors.canvas,
      visualDensity: VisualDensity.standard,
      appBarTheme: const AppBarTheme(
        backgroundColor: MoeenColors.canvas,
        foregroundColor: MoeenColors.primaryDark,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          color: MoeenColors.primaryDark,
          fontSize: 20,
          fontWeight: FontWeight.w700,
        ),
      ),
      cardTheme: CardThemeData(
        color: MoeenColors.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: MoeenColors.border),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: MoeenColors.surface,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: MoeenSpacing.md,
          vertical: MoeenSpacing.md,
        ),
        border: outlinedBorder,
        enabledBorder: outlinedBorder,
        focusedBorder: outlinedBorder.copyWith(
          borderSide: const BorderSide(color: MoeenColors.primary, width: 1.5),
        ),
        errorBorder: outlinedBorder.copyWith(
          borderSide: const BorderSide(color: MoeenColors.danger),
        ),
        focusedErrorBorder: outlinedBorder.copyWith(
          borderSide: const BorderSide(color: MoeenColors.danger, width: 1.5),
        ),
        labelStyle: const TextStyle(color: MoeenColors.primaryDark),
        hintStyle: const TextStyle(color: MoeenColors.mutedText),
        errorStyle: const TextStyle(
          color: MoeenColors.danger,
          fontWeight: FontWeight.w600,
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size.fromHeight(52),
          padding: const EdgeInsets.symmetric(
            horizontal: MoeenSpacing.lg,
            vertical: MoeenSpacing.sm,
          ),
          backgroundColor: MoeenColors.primary,
          foregroundColor: Colors.white,
          disabledBackgroundColor: const Color(0xFFB8C9C6),
          disabledForegroundColor: const Color(0xFF5C716E),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size.fromHeight(52),
          padding: const EdgeInsets.symmetric(
            horizontal: MoeenSpacing.lg,
            vertical: MoeenSpacing.sm,
          ),
          foregroundColor: MoeenColors.primaryDark,
          side: const BorderSide(color: MoeenColors.border),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: MoeenColors.primaryDark,
        contentTextStyle: const TextStyle(color: Colors.white),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      dividerTheme: const DividerThemeData(color: MoeenColors.border, space: 1),
    );
  }
}

class MoeenPageScaffold extends StatelessWidget {
  const MoeenPageScaffold({
    super.key,
    this.title,
    this.leading,
    this.actions,
    required this.body,
    this.bottomAction,
    this.padding = const EdgeInsets.all(MoeenSpacing.md),
  });

  final String? title;
  final Widget? leading;
  final List<Widget>? actions;
  final Widget body;
  final Widget? bottomAction;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: title == null
          ? null
          : AppBar(title: Text(title!), leading: leading, actions: actions),
      body: SafeArea(
        top: title == null,
        child: Padding(padding: padding, child: body),
      ),
      bottomNavigationBar: bottomAction == null
          ? null
          : SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(
                  MoeenSpacing.md,
                  MoeenSpacing.sm,
                  MoeenSpacing.md,
                  MoeenSpacing.md,
                ),
                child: bottomAction,
              ),
            ),
    );
  }
}

class MoeenSectionCard extends StatelessWidget {
  const MoeenSectionCard({
    super.key,
    this.title,
    this.subtitle,
    required this.child,
    this.padding = const EdgeInsets.all(MoeenSpacing.md),
  });

  final String? title;
  final String? subtitle;
  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: padding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (title != null) ...[
              Text(
                title!,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: MoeenColors.primaryDark,
                  fontWeight: FontWeight.w700,
                ),
              ),
              if (subtitle != null) const SizedBox(height: MoeenSpacing.xs),
            ],
            if (subtitle != null) ...[
              Text(
                subtitle!,
                style: Theme.of(
                  context,
                ).textTheme.bodyMedium?.copyWith(color: MoeenColors.mutedText),
              ),
              const SizedBox(height: MoeenSpacing.md),
            ],
            child,
          ],
        ),
      ),
    );
  }
}

class MoeenStatePanel extends StatelessWidget {
  const MoeenStatePanel({
    super.key,
    required this.icon,
    required this.title,
    required this.description,
    this.action,
    this.tint = MoeenColors.primary,
  });

  final IconData icon;
  final String title;
  final String description;
  final Widget? action;
  final Color tint;

  factory MoeenStatePanel.loading({String title = 'جارٍ التحميل'}) {
    return const MoeenStatePanel(
      icon: Icons.hourglass_top_rounded,
      title: 'جارٍ التحميل',
      description: 'نحضّر المعلومات لك الآن.',
    );
  }

  factory MoeenStatePanel.error({
    required String title,
    required String description,
    required VoidCallback onRetry,
  }) {
    return MoeenStatePanel(
      icon: Icons.error_outline_rounded,
      title: title,
      description: description,
      tint: MoeenColors.danger,
      action: OutlinedButton.icon(
        onPressed: onRetry,
        icon: const Icon(Icons.refresh_rounded),
        label: const Text('إعادة المحاولة'),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(MoeenSpacing.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: tint.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, color: tint, size: 28),
              ),
              const SizedBox(height: MoeenSpacing.md),
              Text(
                title,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  color: MoeenColors.primaryDark,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: MoeenSpacing.xs),
              Text(
                description,
                textAlign: TextAlign.center,
                style: Theme.of(
                  context,
                ).textTheme.bodyMedium?.copyWith(color: MoeenColors.mutedText),
              ),
              if (action != null) ...[
                const SizedBox(height: MoeenSpacing.md),
                action!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}

enum MoeenStatusTone { neutral, info, success, warning, danger }

class MoeenStatusChip extends StatelessWidget {
  const MoeenStatusChip({
    super.key,
    required this.label,
    this.tone = MoeenStatusTone.neutral,
    this.compact = false,
  });

  final String label;
  final MoeenStatusTone tone;
  final bool compact;

  ({Color foreground, Color background, IconData icon}) get _appearance {
    return switch (tone) {
      MoeenStatusTone.info => (
        foreground: MoeenColors.info,
        background: const Color(0xFFE8F1FF),
        icon: Icons.info_outline_rounded,
      ),
      MoeenStatusTone.success => (
        foreground: MoeenColors.success,
        background: const Color(0xFFE7F6EC),
        icon: Icons.check_circle_outline_rounded,
      ),
      MoeenStatusTone.warning => (
        foreground: MoeenColors.warning,
        background: const Color(0xFFFFF4D6),
        icon: Icons.schedule_rounded,
      ),
      MoeenStatusTone.danger => (
        foreground: MoeenColors.danger,
        background: const Color(0xFFFDECEC),
        icon: Icons.error_outline_rounded,
      ),
      MoeenStatusTone.neutral => (
        foreground: MoeenColors.mutedText,
        background: const Color(0xFFEAF2F0),
        icon: Icons.circle_outlined,
      ),
    };
  }

  @override
  Widget build(BuildContext context) {
    final appearance = _appearance;
    return Semantics(
      label: 'الحالة: $label',
      child: Container(
        constraints: const BoxConstraints(minHeight: 32),
        padding: EdgeInsets.symmetric(
          horizontal: compact ? MoeenSpacing.xs : MoeenSpacing.sm,
          vertical: MoeenSpacing.xxs,
        ),
        decoration: BoxDecoration(
          color: appearance.background,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(appearance.icon, color: appearance.foreground, size: 16),
            const SizedBox(width: MoeenSpacing.xxs),
            Flexible(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: appearance.foreground,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class MoeenPendingButton extends StatelessWidget {
  const MoeenPendingButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.isPending = false,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool isPending;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      onPressed: isPending ? null : onPressed,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 160),
        child: isPending
            ? const SizedBox(
                key: ValueKey('pending'),
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              )
            : Row(
                key: const ValueKey('ready'),
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 20),
                    const SizedBox(width: MoeenSpacing.xs),
                  ],
                  Text(label),
                ],
              ),
      ),
    );
  }
}
