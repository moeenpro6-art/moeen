abstract interface class SessionKeyValueStore {
  Future<void> write(String key, String value);
  Future<String?> read(String key);
  Future<void> deleteAll();
}

class CustomerSession {
  const CustomerSession({required this.token, required this.customerId});

  final String token;
  final String customerId;

  @override
  bool operator ==(Object other) =>
      other is CustomerSession && other.token == token && other.customerId == customerId;

  @override
  int get hashCode => Object.hash(token, customerId);
}

class CustomerSessionManager {
  CustomerSessionManager(this._store);

  static const _tokenKey = 'moeen_auth_token';
  static const _customerIdKey = 'moeen_customer_id';
  final SessionKeyValueStore _store;

  Future<void> save({required String token, required String customerId}) async {
    await _store.write(_tokenKey, token);
    await _store.write(_customerIdKey, customerId);
  }

  Future<CustomerSession?> restore() async {
    final token = await _store.read(_tokenKey);
    final customerId = await _store.read(_customerIdKey);
    if (token == null || customerId == null) return null;
    return CustomerSession(token: token, customerId: customerId);
  }

  Future<void> clear() => _store.deleteAll();
}
