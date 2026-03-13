Ниже — **черновая спека v1** в формате “можно сразу кодить”.
Это **не стандарт**, а моя рекомендованная схема под твои требования:

* bootstrap новой ноды через **одноразовый pairing code**
* обычный транспорт после этого через **Noise_NK**
* relay остаётся **полностью прозрачным**
* старый протокол не учитываем
* на будущее закладываем **version negotiation**, причём его результат привязываем к криптографическому transcript

`SPAKE2` подходит для bootstrap, потому что это PAKE для двух сторон с общим секретом; RFC 9382 описывает его как two-round protocol, где первый раунд устанавливает shared secret, а второй делает key confirmation. RFC 8125 отдельно различает balanced и augmented PAKE; для вашего pairing-сценария, где обе стороны временно знают один и тот же code, нужен именно balanced PAKE. RFC 9382 также требует аккуратно задавать identities/AAD, иначе можно словить unknown key-share. ([RFC Editor][1])

---

# 1. Pairing spec v1

## 1.1. Криптопрофиль

**Bootstrap PAKE suite**

* `SPAKE2-edwards25519-SHA256-HKDF-HMAC`

RFC 9382 перечисляет ciphersuite для `edwards25519 + SHA256 + HKDF + HMAC`, так что это не экзотика. ([RFC Editor][1])

**Назначение pairing-фазы**

Pairing **не** является рабочим транспортом для RPC.
Он делает только три вещи:

1. доказывает, что клиент и нода знают один и тот же одноразовый pairing code
2. безопасно передаёт клиенту постоянную transport-identity ноды
3. заставляет клиента **сразу проверить** эту identity через реальный Noise transport, прежде чем сохранить ноду в конфиг

---

## 1.2. Pairing code

### Формат

Пользователь видит один код, например:

```text
Q7ND-M4KP-2X9F-T6RW-8BHC
```

Код — это Crockford Base32 от структуры:

```json
{
  "version": 1,
  "secret": 80 random bits,
  "checksum": 16 bits
}
```

Где:

* `secret` — основной bootstrap secret
* `checksum` — только для защиты от опечаток
* `version` — версия формата pairing code

### Производные значения

Нода и клиент одинаково вычисляют:

```text
enroll_id = trunc64(BLAKE3("orka/pair/v1/enroll-id" || secret))
```

`enroll_id` не печатается пользователю отдельно.
Он нужен только для маршрутизации через relay.

### UX

На ноде:

```bash
orka node pair start
```

Вывод:

```text
Pairing code: Q7ND-M4KP-2X9F-T6RW-8BHC
Expires in: 10m
```

На клиенте:

```bash
orka node add Q7ND-M4KP-2X9F-T6RW-8BHC
```

---

## 1.3. Состояние на ноде

После `pair start` нода создаёт **pending enrollment** в памяти:

```json
{
  "enroll_id": "8-byte hex/base64url",
  "secret_hash": "BLAKE3(secret)",
  "expires_at": "...",
  "attempts_left": 8,
  "used": false,
  "node_transport_static_pubkey": "...",
  "node_id": "...",
  "relay_paths": ["wss://relay.example.com/v1/node/node-123"]
}
```

Правила:

* TTL по умолчанию: 10 минут
* после успеха pairing запись уничтожается
* после `attempts_left == 0` запись уничтожается
* нода может иметь несколько активных pending enrollment одновременно

---

## 1.4. Pairing route

Клиент открывает:

```text
wss://relay.example.com/v1/pair/<enroll_id>
```

Relay делает только:

* lookup по `enroll_id`
* байты клиент → нода
* байты нода → клиент

Relay **не знает** `secret`, не знает SPAKE2, не знает Noise, не смотрит в payload.

---

## 1.5. Pairing wire protocol

## 1.5.1. Cleartext negotiation

Чтобы заложить будущее versioning без downgrade-сюрпризов, делаем явные `hello`, а их канонический transcript включаем в SPAKE2 AAD.

### C → N

```json
{
  "t": "pair_client_hello",
  "v": 1,
  "pair_suites": ["SPAKE2-edwards25519-SHA256-HKDF-HMAC"],
  "client_instance_id": "16 random bytes, base64url",
  "features": []
}
```

### N → C

```json
{
  "t": "pair_server_hello",
  "v": 1,
  "pair_suite": "SPAKE2-edwards25519-SHA256-HKDF-HMAC",
  "enroll_id": "<base64url>",
  "expires_in_sec": 600,
  "features": []
}
```

### Pairing transcript context

Обе стороны вычисляют:

```text
pair_context = CanonicalJSON(pair_client_hello) || CanonicalJSON(pair_server_hello)
pair_aad = "orka-pair/v1" || relay_origin || pair_context
```

RFC 9382 прямо говорит, что AAD полезен для привязки протокольного контекста и предотвращения downgrade, а identities нельзя бездумно оставлять пустыми, если identity не “подразумевается сама собой”. ([RFC Editor][1])

### SPAKE2 identities

Задаём:

```text
A = client_instance_id
B = enroll_id
AAD = pair_aad
password = secret
```

Это убирает двусмысленность “кто с кем paired”.

---

## 1.5.2. SPAKE2 exchange

RFC 9382 описывает SPAKE2 как two-round protocol: сначала обмен `pA/pB`, затем key confirmation через отдельные confirmation keys. ([RFC Editor][1])

### C → N: `pair_init`

```json
{
  "t": "pair_init",
  "pA": "<base64url SPAKE2 public value>"
}
```

### N → C: `pair_resp`

```json
{
  "t": "pair_resp",
  "pB": "<base64url SPAKE2 public value>"
}
```

После этого обе стороны вычисляют по RFC 9382:

* `Ke` — shared secret pairing-сессии
* `Ka`
* `KcA`, `KcB` — ключи для key confirmation ([RFC Editor][1])

### C → N: `pair_confirm1`

```json
{
  "t": "pair_confirm1",
  "mac": "<base64url>"
}
```

### N → C: `pair_confirm2`

```json
{
  "t": "pair_confirm2",
  "mac": "<base64url>"
}
```

Если любой MAC неверный:

* нода уменьшает `attempts_left`
* отвечает `pair_error`
* закрывает соединение

---

## 1.5.3. Bootstrap encrypted channel

После успешного key confirmation обе стороны выводят bootstrap-ключи:

```text
boot_c2s = HKDF(Ke, "orka-pair/v1 boot c2s", 32)
boot_s2c = HKDF(Ke, "orka-pair/v1 boot s2c", 32)
boot_export = HKDF(Ke, "orka-pair/v1 export", 32)
```

Дальше используется `ChaCha20-Poly1305`:

* nonce 0 для первого сообщения в каждом направлении
* AAD = `SHA256(pair_context)`

### N → C: `pair_bootstrap`

Шифруется под `boot_s2c`, nonce=0.

Plaintext:

```json
{
  "node_id": "node-123",
  "node_name": "fra1-gpu-01",
  "noise_suite": "Noise_NK_25519_ChaChaPoly_SHA256",
  "noise_static_pubkey": "<base64url 32 bytes>",
  "noise_key_id": "sha256:....",
  "node_paths": ["wss://relay.example.com/v1/node/node-123"],
  "rpc": ["jsonrpc-2.0"]
}
```

Wire:

```json
{
  "t": "pair_bootstrap",
  "ct": "<base64url>"
}
```

---

## 1.6. Когда клиент считает pairing успешным

**Не сразу после `pair_bootstrap`.**

Клиент обязан:

1. извлечь `noise_static_pubkey`
2. закрыть pairing-сессию
3. открыть обычное transport-соединение к `node_paths[0]`
4. выполнить **реальный Noise_NK handshake**
5. только после успешного handshake сохранить ноду в конфиг

Иначе ты сохраняешь “полученный по pairing-каналу ключ”, но не убеждаешься, что нода реально владеет соответствующим приватным ключом.

После успешного Noise_NK клиент пишет:

```json
{
  "node_id": "node-123",
  "node_name": "fra1-gpu-01",
  "noise_static_pubkey": "...",
  "noise_key_id": "...",
  "node_paths": ["wss://relay.example.com/v1/node/node-123"],
  "trust": {
    "mode": "paired",
    "paired_at": "...",
    "pairing_export": "<optional hash of boot_export>"
  }
}
```

После этого клиент может послать ноде:

```json
{
  "t": "pair_done"
}
```

И нода помечает enrollment как `used=true`.

---

## 1.7. Pairing errors

Cleartext ошибки:

```json
{
  "t": "pair_error",
  "code": "expired | not_found | attempts_exhausted | bad_version | bad_suite | protocol_error"
}
```

Правила:

* `not_found` и `expired` не раскрывают лишних деталей
* после `attempts_exhausted` нода сразу удаляет enrollment
* любые лишние/неожиданные кадры = `protocol_error`

---

# 2. Transport protocol spec v1

## 2.1. Криптопрофиль

**Transport suite**

* `Noise_NK_25519_ChaChaPoly_SHA256`

В `NK` у initiator заранее известен static public key responder’а; сам паттерн в Noise выглядит как pre-message `<- s`, затем `-> e, es`, затем `<- e, ee`. После handshake стороны получают transport cipher states и переходят к encrypted transport messages. ([noiseprotocol.org][2])

---

## 2.2. Transport route

Клиент открывает:

```text
wss://relay.example.com/v1/node/<node_id>
```

Никаких query params с ключами нет.

Relay:

* маршрутизирует по `node_id`
* форвардит opaque frames
* не знает Noise state
* не знает RPC

---

## 2.3. Cleartext negotiation

Чтобы потом можно было добавить `v2`, новые suites и дополнительные app protocols, делаем hello-обмен **до** Noise, а результат включаем в Noise prologue. Noise прямо поддерживает prologue и указывает, что несовпадение prologue приведёт к handshake failure; это как раз механизм привязки к предыдущему negotiation. ([noiseprotocol.org][2])

### C → N

```json
{
  "t": "client_hello",
  "v": 1,
  "noise_suites": ["Noise_NK_25519_ChaChaPoly_SHA256"],
  "node_id": "node-123",
  "expected_key_id": "sha256:....",
  "app_protocols": ["jsonrpc-2.0"],
  "features": []
}
```

### N → C

```json
{
  "t": "server_hello",
  "v": 1,
  "noise_suite": "Noise_NK_25519_ChaChaPoly_SHA256",
  "node_id": "node-123",
  "key_id": "sha256:....",
  "app_protocol": "jsonrpc-2.0",
  "features": [],
  "max_frame": 1048576
}
```

Если `expected_key_id` не совпадает с реальным `key_id`, сервер может сразу закрыть соединение с `key_id_mismatch`.

### Prologue

Обе стороны вычисляют:

```text
transcript = CanonicalJSON(client_hello) || CanonicalJSON(server_hello)

prologue =
  "orka-transport/v1" ||
  relay_origin ||
  transcript
```

---

## 2.4. Noise handshake frames

### C → N: `noise_1`

```json
{
  "t": "noise_1",
  "msg": "<base64url raw Noise handshake message 1>"
}
```

Содержимое — результат `WriteMessage()` для первого хода `NK`.

### N → C: `noise_2`

```json
{
  "t": "noise_2",
  "msg": "<base64url raw Noise handshake message 2>"
}
```

После второго сообщения обе стороны вызывают `Split()` и получают transport cipher states. Noise отдельно описывает, что после завершения handshake именно chaining key порождает транспортные ключи, а `GetHandshakeHash()` можно использовать как channel binding для app-level auth в будущем. ([noiseprotocol.org][2])

### Session binding

После успешного handshake приложение сохраняет:

```text
session_id = GetHandshakeHash()
```

Noise прямо рекомендует `GetHandshakeHash()` для channel binding: его можно потом подписывать или хешировать вместе с password/token, чтобы auth-token нельзя было переиспользовать в другой сессии. ([noiseprotocol.org][2])

Это пригодится, если позже захочешь добавить **аутентификацию клиента**, не меняя сам transport pattern.

---

## 2.5. Encrypted transport frames

После `noise_2` **все** последующие кадры идут только как transport ciphertext.

### Wire frame

```json
{
  "t": "data",
  "ct": "<base64url raw Noise transport ciphertext>"
}
```

### Plaintext внутри `ct`

UTF-8 JSON:

```json
{
  "v": 1,
  "kind": "rpc",
  "rpc": {
    "jsonrpc": "2.0",
    "id": "1",
    "method": "spawn",
    "params": {
      "image": "ubuntu"
    }
  }
}
```

То есть transport шифрует **весь app message**, а не отдельные поля.

### Nonce

В `v1` `nonce` в wire **не передаётся**.

Причина: для ordered WebSocket этого не нужно; Noise предлагает передавать `n` рядом с сообщением только в сценариях с потерей/перестановкой сообщений, например поверх UDP. ([noiseprotocol.org][2])

---

## 2.6. Transport state machine

### Client

* `WS_OPEN`
* `HELLO_SENT`
* `HELLO_CONFIRMED`
* `NOISE_1_SENT`
* `SECURE`
* `CLOSED`

### Node

* `WS_OPEN`
* `HELLO_RCVD`
* `HELLO_SENT`
* `NOISE_2_SENT`
* `SECURE`
* `CLOSED`

Любой неожиданный кадр в неверном состоянии:

* cleartext phase → `transport_error(protocol_error)` и close
* secure phase → close с generic reason

---

## 2.7. Cleartext transport errors

До входа в secure mode можно возвращать:

```json
{
  "t": "transport_error",
  "code": "unsupported_version | unsupported_suite | no_such_node | key_id_mismatch | protocol_error"
}
```

После входа в secure mode:

* все прикладные ошибки идут уже обычным JSON-RPC error внутри `data`

---

## 2.8. Rekey и reconnection

В `v1` политика простая:

* один WS = одна Noise session
* reconnect = новый handshake
* rekey внутри живой сессии не делаем

Noise поддерживает `Rekey()`, но сам Noise spec оставляет policy приложениям; если когда-нибудь захотите rekey по таймеру или по числу сообщений, это можно добавить без ломки общей архитектуры. 

---

# 3. Что важно зафиксировать сейчас, чтобы не пожалеть потом

1. **Pairing и transport — разные протоколы.**
   Pairing не возит RPC.

2. **Один trust bootstrap = pairing code.**
   После pairing клиент работает только с pinned `noise_static_pubkey`.

3. **Любая negotiation строка должна входить в AAD/prologue.**
   Это главный hook для future compatibility без тихих downgrade’ов. Noise prologue и SPAKE2 AAD для этого и нужны. ([noiseprotocol.org][2])

4. **Client commit только после реального Noise connect.**
   Не после `pair_bootstrap`.

5. **Unknown fields игнорируются, unknown required values — ошибка.**
   Это позволит добавлять поля в `v1.x`.

---

# 4. Мой короткий verdict

Если совсем коротко, то я бы кодил именно так:

* **bootstrap**: `SPAKE2-edwards25519-SHA256-HKDF-HMAC`
* **human UX**: `orka node pair start` → код → `orka node add <code>`
* **рабочий transport**: `Noise_NK_25519_ChaChaPoly_SHA256`
* **relay**: только маршрутизация и форвардинг
* **всё будущее negotiation**: обязательно bind в `AAD/prologue`

Следующим сообщением я могу превратить это в более “инженерный” формат:
**TypeScript interfaces + sequence diagrams + список функций `client.ts / relay.ts / node.ts`**, чтобы это уже можно было распилить по файлам.

[1]: https://www.rfc-editor.org/rfc/rfc9382.html "RFC 9382: SPAKE2, a Password-Authenticated Key Exchange"
[2]: https://noiseprotocol.org/noise.pdf "The Noise Protocol Framework"
