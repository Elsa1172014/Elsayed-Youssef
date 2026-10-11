import Foundation

public struct Channel: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var group: String?
    public var hidden: Bool
}

private struct StreamResponse: Codable { let url: String }
private struct TokenResponse: Codable { let token: String }
private struct Credentials: Codable { let username: String; let password: String }

public enum APIError: Error, Equatable { case http(Int), badURL }

/// Thin client for the Smart Receiver API (username/password accounts, bearer session token).
/// Persist the token in the Keychain before release; this type only holds it in memory.
public struct ReceiverAPI: Sendable {
    public let base: URL
    public private(set) var token: String
    private let session: URLSession

    public init(base: URL, token: String = "", session: URLSession = .shared) {
        self.base = base
        self.token = token
        self.session = session
    }

    /// Signs in and returns a copy of the client that carries the new session token.
    public func signedIn(username: String, password: String) async throws -> ReceiverAPI {
        guard let url = URL(string: "/v1/auth/login", relativeTo: base) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(Credentials(username: username, password: password))
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { throw APIError.http(http.statusCode) }
        let t = try JSONDecoder().decode(TokenResponse.self, from: data).token
        return ReceiverAPI(base: base, token: t, session: session)
    }

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        guard let url = URL(string: path, relativeTo: base) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { throw APIError.http(http.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func channels() async throws -> [Channel] {
        try await get("/v1/me/channels", as: [Channel].self).filter { !$0.hidden }
    }

    /// Playable URL; AVPlayer then streams directly from the origin (the backend never proxies media).
    public func streamURL(channelID: String) async throws -> URL {
        let r = try await get("/v1/me/channels/\(channelID)/stream", as: StreamResponse.self)
        guard let u = URL(string: r.url) else { throw APIError.badURL }
        return u
    }
}
