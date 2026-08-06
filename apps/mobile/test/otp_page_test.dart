import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_mobile/main.dart';

void main() {
  testWidgets('OTP entry starts empty and never pre-fills a development code', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: OtpPage(challengeId: 'challenge-id', phone: '+966500000001'),
      ),
    );

    final field = tester.widget<EditableText>(find.byType(EditableText));
    expect(field.controller.text, isEmpty);
  });
}
