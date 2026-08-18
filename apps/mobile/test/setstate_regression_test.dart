import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// Guards against the Flutter runtime error
// "setState() callback argument returned a Future."
// `_load()` returns a Future, so the setState callback must use a block body
// (which returns void) instead of an arrow body that returns the assignment
// expression's value (the Future).
void main() {
  test('main.dart setState callbacks never return the _requests Future', () {
    final source = File('lib/main.dart').readAsStringSync();
    final badPattern = RegExp(
      r'setState\(\(\)\s*=>\s*_requests\s*=\s*_load\(\)\)',
    );

    expect(
      badPattern.hasMatch(source),
      isFalse,
      reason: 'setState(() => _requests = _load()) returns the Future from '
          '_load() and throws "setState() callback argument returned a '
          'Future." at runtime. Use a block body: '
          'setState(() { _requests = _load(); })',
    );
  });
}
