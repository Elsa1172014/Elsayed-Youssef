import XCTest
@testable import ReceiverKit

final class ReceiverKitTests: XCTestCase {
    func testChannelDecoding() throws {
        let json = #"[{"id":"1","name":"Al Jazeera","group":"News","hidden":false,"streamUrl":"https://e.org/a.m3u8"}]"#
        let channels = try JSONDecoder().decode([Channel].self, from: Data(json.utf8))
        XCTAssertEqual(channels.first?.name, "Al Jazeera")
    }
}
