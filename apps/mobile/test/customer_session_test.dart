import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_mobile/customer_session.dart';

class FakeStore implements SessionKeyValueStore {
  final values = <String, String>{};

  @override
  Future<void> deleteAll() async => values.clear();

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

void main() {
  test('persists and restores an authenticated customer session', () async {
    final session = CustomerSessionManager(FakeStore());

    await session.save(token: 'token-123', customerId: 'CUS-1001');

    expect(await session.restore(), const CustomerSession(token: 'token-123', customerId: 'CUS-1001'));
  });
}
