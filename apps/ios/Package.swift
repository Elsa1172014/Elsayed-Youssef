// swift-tools-version:5.9
import PackageDescription

// ReceiverKit holds the API client and models shared by the iOS and tvOS apps.
let package = Package(
    name: "ReceiverKit",
    platforms: [.iOS(.v16), .tvOS(.v16), .macOS(.v13)],
    products: [.library(name: "ReceiverKit", targets: ["ReceiverKit"])],
    targets: [
        .target(name: "ReceiverKit"),
        .testTarget(name: "ReceiverKitTests", dependencies: ["ReceiverKit"]),
    ]
)
