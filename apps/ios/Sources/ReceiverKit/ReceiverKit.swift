import Foundation

public struct Channel: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var group: String?
    public var hidden: Bool
}

private struct StreamResponse: Codable { let url: String }

public enum APIError: Error, Equatable { case http(Int), badURL }

/// Thin client for the Smart Receiver API. The dev token scheme is a placeholder until real auth lands.
public struct ReceiverAPI: Sendable {
    public let base: URL
    public let token: String
    private let session: URLSession

    public init(base: URL, token: String, session: URLSession = .shared) {
        self.base = base
        self.token = token
        self.session = session
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
