class MoeenApiConfigurationException implements Exception {
  const MoeenApiConfigurationException();
}

class MoeenApiConfig {
  const MoeenApiConfig(this.baseUrl);

  final String baseUrl;

  Uri endpoint(String path) {
    final normalizedBase = baseUrl.trim().replaceFirst(RegExp(r'/$'), '');
    final parsed = Uri.tryParse(normalizedBase);

    if (parsed == null ||
        !(parsed.scheme == 'http' || parsed.scheme == 'https') ||
        parsed.host.isEmpty ||
        !path.startsWith('/')) {
      throw const MoeenApiConfigurationException();
    }

    return Uri.parse('$normalizedBase$path');
  }
}

/// Set at build/run time. A physical Android device must use a reachable LAN
/// address in development; production must use the HTTPS API origin.
const moeenApi = MoeenApiConfig(String.fromEnvironment('MOEEN_API_BASE_URL'));
