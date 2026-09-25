# ADR-002: iOS Push Client (Message Receiving End)

**Status:** Draft
**Date:** 2026-09-23
**Deciders:** hengistchan
**Technical Story:** Build an iOS client that receives SMS notifications, messages, contacts, and call events relayed from the Android gateway via APNs push.

---

## 1. Overview

### 1.1 Goal

An iOS app that serves as the remote viewing end of the CA Connection gateway system. The Android gateway (Phone A) captures SMS, notifications, contacts, and call events. The server processes and stores these, then pushes them to the iOS client (Phone B) via Apple Push Notification service (APNs).

### 1.2 Reference

Bark (https://github.com/Finb/Bark) — a lightweight iOS push notification receiver. Our system extends this concept: instead of arbitrary HTTP → push, the data source is a structured Android SMS gateway with typed events.

### 1.3 Non-Goals

- iOS does **not** read SMS, notifications, or call logs directly. iOS prohibits third-party access to these. All capture happens on the Android gateway.
- No real-time voice relay in this phase.
- No outbound SMS from the iOS client (future extension via the existing RemoteCommand pipeline).

---

## 2. Architecture

```
┌──────────────────┐       ┌──────────────────────┐       ┌──────────┐       ┌──────────────────┐
│  Android Gateway │       │      CA Server       │       │  Apple   │       │   iOS Client     │
│  (Phone A)       │       │    (server-node)     │       │  APNs    │       │   (Phone B)      │
│                  │       │                      │       │          │       │                  │
│  SMS capture ────┼──────>│  Ingest & store ────┼──────>│  Push ───┼──────>│  Notification    │
│  Notification ───┼──────>│  Event pipeline ────┼──────>│  Gateway │       │  Banner / List   │
│  Call events ────┼──────>│  APNs sender ───────┼──────>│          │       │  History / Search│
│  Contacts ───────┼──────>│  REST API ───────────┼<──────┼──────────┼───────│  Contact sync    │
│                  │       │                      │       │          │       │                  │
└──────────────────┘       └──────────────────────┘       └──────────┘       └──────────────────┘
```

### 2.1 Data Flow

**Real-time push path:**

```
Android captures event
  → HTTP POST /api/v1/events (existing AuthenticatedHttpTransport)
  → Server stores in event pipeline
  → Server calls APNs sender
  → APNs delivers to iOS device
  → iOS displays notification banner
```

**Pull/sync path (for history and contacts):**

```
iOS app opens
  → GET /api/v1/events?since=<cursor>&type=sms,notification,call
  → GET /api/v1/contacts?since=<cursor>
  → Render list / search locally
```

---

## 3. Event Types

| Type | Android Source | Push Payload Key | iOS Display |
|------|---------------|-----------------|-------------|
| `sms_incoming` | `IncomingSmsProcessor` | `sms` | SMS bubble with sender + body |
| `sms_outgoing` | `OutgoingSmsEventEntity` | `sms_out` | Outgoing status |
| `notification` | `GatewayNotificationListenerService` | `notif` | App notification card |
| `call_incoming` | `CallEventEntity` | `call` | Incoming call entry |
| `call_missed` | `CallEventEntity` | `call_missed` | Missed call badge |
| `call_identity` | `CallIdentityEventEntity` | `caller_id` | Caller ID card |
| `contact_sync` | Contact collector (new) | `contact` | Contact update |
| `device_state` | `DeviceStateReporter` | `device` | Gateway status (silent) |

### 3.1 Push Payload Schema (APNs `custom`)

```json
{
  "aps": {
    "alert": {
      "title": "SMS from +86 138xxxx1234",
      "body": "Your verification code is 456789"
    },
    "sound": "default",
    "badge": 1,
    "mutable-content": 1,
    "category": "GATEWAY_EVENT"
  },
  "gateway": {
    "event_id": "evt_abc123",
    "type": "sms_incoming",
    "timestamp": 1790176656000,
    "data": {
      "originating_address": "+86138xxxx1234",
      "body": "Your verification code is 456789",
      "sim_slot": 0,
      "received_at": 1790176655000
    }
  }
}
```

### 3.2 Notification Categories (iOS)

| Category | Actions |
|----------|---------|
| `GATEWAY_EVENT` | View (default) |
| `SMS_INCOMING` | View, Reply (future), Forward (future) |
| `CALL_MISSED` | View, Callback (future) |
| `CONTACT_SYNC` | View (silent) |

---

## 4. Server-Side: APNs Push Module

### 4.1 Technology Choice

| Option | Pros | Cons |
|--------|------|------|
| **aioapns** (Python) | Async, simple | Python dependency |
| **node-apn** (Node.js) | Fits existing server-node | Unmaintained |
| **http/2 + JWT** (custom) | No dependency | More code |
| **Firebase Admin SDK** | Cross-platform (FCM for Android too) | Extra vendor |

**Decision: `aioapns`** — the server has a Python component (tools/), and aioapns is the most actively maintained APNs library. Alternatively, if server-node is the primary server, use raw HTTP/2 with JWT auth (Apple's recommended approach, zero dependency).

### 4.2 APNs Configuration

```
APNs Auth Key file: AuthKey_<KEYID>.p8
Key ID: <10-char>
Team ID: <10-char>
Bundle ID: com.caconnection.gateway.client
Environment: production (or sandbox for dev)
```

### 4.3 API Endpoints (server-node extensions)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/devices/register` | Register iOS device token |
| `DELETE` | `/api/v1/devices/{token}` | Unregister device |
| `POST` | `/api/v1/events` | (existing) Android gateway ingest |
| `GET` | `/api/v1/events` | Fetch events with pagination |
| `GET` | `/api/v1/contacts` | Fetch synced contacts |
| `GET` | `/api/v1/push/status` | Push delivery status (debug) |

### 4.4 Device Registration Flow

```
iOS app first launch
  → Request notification permission (UNUserNotificationCenter)
  → Register for remote notifications (UIApplication.registerForRemoteNotifications)
  → Get deviceToken from APNs
  → POST /api/v1/devices/register
     Body: { "device_token": "hex...", "platform": "ios", "app_version": "1.0.0" }
  → Server stores device token, associates with gateway account
```

### 4.5 Push Sender Logic

```python
# Pseudocode for event → push pipeline
async def on_event_received(event):
    store_event(event)
    devices = get_registered_devices(account_id=event.account_id)
    payload = build_apns_payload(event)
    for device in devices:
        await apns.send_notification(payload, device.device_token)
```

**Push strategy:**

| Event Type | Priority | Sound | Grouping |
|------------|----------|-------|----------|
| `sms_incoming` | Immediate | Yes | By sender |
| `notification` | Immediate | Configurable | By source app |
| `call_missed` | Immediate | Yes | Daily digest |
| `contact_sync` | Silent (content-available) | No | Batch |
| `device_state` | Silent | No | N/A |

---

## 5. iOS Client

### 5.1 Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Language | Swift 5.9+ | Modern, safe |
| UI | SwiftUI | Declarative, fast iteration |
| Min iOS | 16.0 | Covers 95%+ devices |
| Networking | URLSession + async/await | No third-party dependency |
| Local storage | SwiftData (iOS 17+) or Core Data | Offline history |
| Push | UserNotifications + APNs | System-native |
| Contacts | Contacts framework (CNContactStore) | Read-only display |

### 5.2 Project Structure

```
ios/GatewayClient/
├── App/
│   ├── GatewayClientApp.swift          # App entry, push registration
│   └── AppDelegate.swift               # APNs token handling
├── Models/
│   ├── GatewayEvent.swift              # Unified event model
│   ├── SMSEvent.swift
│   ├── NotificationEvent.swift
│   ├── CallEvent.swift
│   └── Contact.swift
├── Services/
│   ├── APNsService.swift               # Push registration & handling
│   ├── GatewayAPI.swift                # REST API client
│   ├── EventStore.swift                # Local persistence (SwiftData/Core Data)
│   └── ContactSync.swift               # Contact list sync
├── Views/
│   ├── ContentView.swift               # TabView root
│   ├── EventListView.swift             # Unified event feed
│   ├── EventDetailView.swift           # Single event detail
│   ├── ContactListView.swift           # Contact browser
│   ├── SettingsView.swift              # Gateway URL, device management
│   └── Components/
│       ├── SMSBubbleView.swift
│       ├── NotificationCardView.swift
│       └── CallEventRow.swift
├── Resources/
│   ├── Assets.xcassets
│   └── Info.plist
└── GatewayClient.xcodeproj
```

### 5.3 Push Registration (Core Code)

```swift
import UserNotifications
import UIKit

class APNsService: ObservableObject {
    @Published var deviceToken: String?
    @Published var isRegistered = false

    func requestPermission() async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
        if granted {
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
        return granted
    }

    // Called from AppDelegate
    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        self.deviceToken = token
        Task {
            try? await GatewayAPI.shared.registerDevice(token: token)
            await MainActor.run { self.isRegistered = true }
        }
    }

    // Handle incoming push
    func handleNotification(userInfo: [AnyHashable: Any]) {
        guard let gateway = userInfo["gateway"] as? [String: Any],
              let type = gateway["type"] as? String else { return }

        let event = GatewayEvent.from(userInfo: gateway)
        EventStore.shared.save(event)
        // UI updates via @Published or NotificationCenter
    }
}
```

### 5.4 Silent Push for Background Sync

For contact sync and bulk event backfill, use silent push (`content-available: 1`):

```json
{
  "aps": {
    "content-available": 1
  },
  "gateway": {
    "type": "contact_sync",
    "action": "sync_contacts"
  }
}
```

iOS will wake the app in the background for ~30 seconds to process.

### 5.5 UI Screens

```
TabView
├── 📨 Events (EventListView)
│   ├── Filter: All / SMS / Notifications / Calls
│   ├── Search bar
│   └── Infinite scroll with cursor pagination
├── 👤 Contacts (ContactListView)
│   ├── Searchable contact list
│   └── Contact detail → related events
└── ⚙️ Settings (SettingsView)
    ├── Gateway server URL
    ├── Device registration status
    ├── Push notification settings
    ├── Data retention policy
    └── About / version
```

### 5.6 Notification Extension (Optional, Phase 2)

A **Notification Service Extension** can modify push content before display:

- Decrypt end-to-end encrypted SMS bodies
- Fetch additional context (e.g., contact name lookup)
- Attach images or rich content

```swift
class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler handler: @escaping (UNNotificationContent) -> Void
    ) {
        let content = request.content.mutableCopy() as! UNMutableNotificationContent
        // Look up contact name for the sender
        if let sender = content.userInfo["gateway"]?["data"]?["originating_address"] {
            content.title = ContactSync.name(for: sender) ?? sender
        }
        handler(content)
    }
}
```

---

## 6. Android Gateway Extensions

### 6.1 Contact Collector (New)

```kotlin
// telephony/contacts/ContactCollector.kt
object ContactCollector {
    fun collect(context: Context, since: Long): List<ContactSnapshot> {
        val resolver = context.contentResolver
        val cursor = resolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            arrayOf(
                ContactsContract.Contacts._ID,
                ContactsContract.Contacts.DISPLAY_NAME,
                ContactsContract.Contacts.PHONE_NUMBER, // simplified
                ContactsContract.Contacts.CONTACT_LAST_UPDATED_TIMESTAMP
            ),
            "${ContactsContract.Contacts.CONTACT_LAST_UPDATED_TIMESTAMP} > ?",
            arrayOf(since.toString()),
            null
        )
        // Map to ContactSnapshot, encrypt, queue to Outbox
    }
}
```

**Permissions needed:**
- `READ_CONTACTS` (currently `ignore` — needs grant)
- Schedule periodic sync via `DeviceStateScheduler` or a new `ContactSyncScheduler`

### 6.2 Sensitive Notification Fix

The `RECEIVE_SENSITIVE_NOTIFICATIONS` appop is currently denied. The user must enable this in:
> Settings → Notifications → Notification access → CA Connection → Show sensitive notifications

Without this, notification content (including SMS OTP codes in notifications) is redacted.

---

## 7. Security & Privacy

| Concern | Mitigation |
|---------|-----------|
| SMS content in transit | TLS 1.3 (existing AuthenticatedHttpTransport) |
| SMS content at rest (server) | AES-256-GCM encryption |
| SMS content at rest (iOS) | Keychain-stored key + encrypted SwiftData |
| APNs payload | Can use `mutable-content` + encryption; APNs payload has 4KB limit |
| Device token theft | Token bound to account; revocable via API |
| Contact data | Encrypted at rest; never logged |

**End-to-end encryption (optional, Phase 3):**
- Generate X25519 keypair on iOS
- Public key registered with server
- Android gateway encrypts event payloads to the iOS public key
- APNs payload contains only ciphertext + metadata for routing
- iOS Notification Service Extension decrypts before display

---

## 8. Development Phases

### Phase 1: Foundation (1 week)

- [ ] Server: APNs push module (`aioapns` or HTTP/2)
- [ ] Server: Device registration API
- [ ] iOS: Project scaffold, push registration
- [ ] iOS: Receive and display push notification
- **Deliverable:** Android SMS arrives as iOS push notification

### Phase 2: Event Feed (1 week)

- [ ] Server: Event query API with pagination
- [ ] iOS: Event list with filters (SMS / Notifications / Calls)
- [ ] iOS: Event detail view
- [ ] iOS: Local storage (SwiftData) for offline access
- **Deliverable:** Full event history browsable on iOS

### Phase 3: Contacts & Enrichment (1 week)

- [ ] Android: Contact collector + periodic sync
- [ ] Server: Contact storage + sync API
- [ ] iOS: Contact list + search
- [ ] iOS: Notification Service Extension (contact name enrichment)
- **Deliverable:** Incoming SMS shows contact name instead of number

### Phase 4: Polish & Security (3-5 days)

- [ ] End-to-end encryption (optional)
- [ ] iOS: Search across all events
- [ ] iOS: Settings / device management UI
- [ ] iOS: Dark mode, accessibility, localization
- [ ] TestFlight beta distribution
- **Deliverable:** Production-ready iOS client

---

## 9. Open Questions

| # | Question | Impact | Status |
|---|---------|--------|--------|
| 1 | Apple Developer account ($99/yr) available? | Blocker for APNs | ⬜ |
| 2 | Push certificate or token-based auth (P8 key)? | APNs setup | ⬜ |
| 3 | Single-device or multi-device push? | Architecture | ⬜ |
| 4 | iOS minimum version target? | SwiftUI/SwiftData choice | ⬜ |
| 5 | Need iMessage/SMS reply from iOS? | Scope increase | ⬜ |
| 6 | Chinese App Store or sideload/TestFlight? | Distribution | ⬜ |

---

## 10. References

- Bark: https://github.com/Finb/Bark
- Apple Push Notification service: https://developer.apple.com/documentation/usernotifications
- aioapns: https://github.com/Fatal1ty/aioapns
- APNs Provider API: https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server/sending_notification_requests_to_apns
- UNNotificationServiceExtension: https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension
- Android READ_CONTACTS: https://developer.android.com/reference/android/provider/ContactsContract
