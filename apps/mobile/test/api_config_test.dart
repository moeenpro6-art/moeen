import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_mobile/api_config.dart';

void main() {
  test('builds API endpoints from an explicitly configured HTTPS base URL', () {
    const config = MoeenApiConfig('https://api.example.test/');

    expect(
      config.endpoint('/auth/request-otp').toString(),
      'https://api.example.test/auth/request-otp',
    );
  });

  test('rejects a missing, non-HTTP, or hostless API base URL', () {
    expect(
      () => const MoeenApiConfig('').endpoint('/services'),
      throwsA(isA<MoeenApiConfigurationException>()),
    );
    expect(
      () => const MoeenApiConfig('ftp://api.example.test').endpoint('/services'),
      throwsA(isA<MoeenApiConfigurationException>()),
    );
    expect(
      () => const MoeenApiConfig('http:///missing-host').endpoint('/services'),
      throwsA(isA<MoeenApiConfigurationException>()),
    );
  });
}
