import 'package:flutter/material.dart';

import 'service_location.dart';

/// Non-map booking summary and action for the full-screen location picker.
class ServiceLocationFormSection extends StatelessWidget {
  const ServiceLocationFormSection({
    super.key,
    required this.controller,
    required this.mode,
    required this.onOpenPicker,
  });

  final ServiceLocationController controller;
  final ServiceLocationMode mode;
  final VoidCallback onOpenPicker;

  @override
  Widget build(BuildContext context) {
    if (mode == ServiceLocationMode.off) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final hasConfirmedPoint = controller.selection?.confirmed ?? false;
        return Semantics(
          container: true,
          label: hasConfirmedPoint
              ? 'تم تأكيد موقع الخدمة'
              : 'لم يتم تحديد موقع الخدمة',
          child: Card(
            key: const Key('booking_location_status_card'),
            margin: const EdgeInsets.only(top: 14),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        hasConfirmedPoint
                            ? Icons.verified_rounded
                            : Icons.location_on_outlined,
                        color: hasConfirmedPoint
                            ? const Color(0xFF0B6E69)
                            : const Color(0xFF66807D),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              hasConfirmedPoint
                                  ? 'تم تأكيد موقع الخدمة'
                                  : 'حدد موقع الخدمة بدقة',
                              style: Theme.of(context).textTheme.titleMedium
                                  ?.copyWith(fontWeight: FontWeight.w700),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              hasConfirmedPoint
                                  ? 'يمكنك تعديل الموقع أو استكمال تفاصيل العنوان أعلاه.'
                                  : 'افتح الخريطة الكاملة وحرّكها حتى يصبح الدبوس فوق موقع الخدمة.',
                              style: const TextStyle(
                                color: Color(0xFF66807D),
                                height: 1.4,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  OutlinedButton.icon(
                    onPressed: onOpenPicker,
                    icon: const Icon(Icons.map_outlined),
                    label: Text(
                      hasConfirmedPoint
                          ? 'تعديل موقع الخدمة على الخريطة'
                          : 'تحديد موقع الخدمة على الخريطة',
                    ),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(50),
                    ),
                  ),
                  if (mode == ServiceLocationMode.optional && hasConfirmedPoint)
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: TextButton.icon(
                        onPressed: controller.clear,
                        icon: const Icon(Icons.clear_rounded),
                        label: const Text('متابعة الطلب بدون موقع محدد'),
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
