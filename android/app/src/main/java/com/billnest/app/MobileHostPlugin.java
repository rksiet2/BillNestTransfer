package com.billnest.app;

import android.util.Log;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.SharedPreferences;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.net.HttpURLConnection;
import java.net.URL;
import android.util.Base64;
import java.security.KeyStore;
import java.security.MessageDigest;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.pdf.PdfDocument;

/**
 * MobileHostPlugin — Capacitor plugin that runs a real HTTP server on Android
 * so a tablet in HOST_DEVICE mode can serve other phones/tablets on the same WiFi.
 *
 * Protocol (identical to electron/lanServer.cjs):
 *   GET  /health  → { ok, hotelName, captainEnabled, tableManagementEnabled, version }
 *   POST /rpc     → { channel, args } → { ok, result } | { ok:false, error }
 *
 * The /rpc handler calls back into JavaScript (webApi.js) via Capacitor's
 * notifyListeners mechanism. JS computes the result and calls rpcRespond() to
 * send the response back to the waiting HTTP request.
 */
@CapacitorPlugin(name = "MobileHost")
public class MobileHostPlugin extends Plugin {

    private static final String TAG = "MobileHostPlugin";
    private static final int DEFAULT_PORT = 4001;
    private static final int MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

    private HttpServer httpServer = null;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final ExecutorService cloudExecutor = Executors.newSingleThreadExecutor();
    private volatile String authToken = "";

    // Pending RPC calls: requestId → waiting exchange
    private final java.util.concurrent.ConcurrentHashMap<String, PendingRpc> pendingRpcs =
            new java.util.concurrent.ConcurrentHashMap<>();
    private static final String CLOUD_PREFS = "billnest_cloud_api";
    private static final String CLOUD_BLOB = "credentials";
    private static final String KEY_ALIAS = "billnest_cloud_api_key";

    private static class PendingRpc {
        final HttpExchange exchange;
        final Object lock = new Object();
        String responseBody = null;
        int statusCode = 200;
        boolean done = false;

        PendingRpc(HttpExchange exchange) {
            this.exchange = exchange;
        }
    }

    /**
         * Small HTTP/1.1 server for Android. The JDK's com.sun.net.httpserver
         * package is not part of the Android runtime, so the host plugin keeps its
         * deliberately small protocol implementation self-contained.
         */
        private static final class HttpServer {
            private final ServerSocket serverSocket;
            private final Map<String, HttpHandler> handlers = new HashMap<>();
            private ExecutorService executor;
            private volatile boolean stopped;

            static HttpServer create(InetSocketAddress address, int backlog) throws IOException {
                ServerSocket socket = new ServerSocket();
                socket.bind(address, backlog);
                return new HttpServer(socket);
            }

            private HttpServer(ServerSocket serverSocket) {
                this.serverSocket = serverSocket;
            }

            void createContext(String path, HttpHandler handler) {
                handlers.put(path, handler);
            }

            void setExecutor(ExecutorService executor) {
                this.executor = executor;
            }

            void start() {
                stopped = false;
                executor.execute(() -> {
                    while (!stopped) {
                        try {
                            Socket socket = serverSocket.accept();
                            executor.execute(() -> handle(socket));
                        } catch (IOException e) {
                            if (!stopped) Log.e(TAG, "HTTP accept failed: " + e.getMessage());
                        }
                    }
                });
            }

            void stop(int delay) {
                stopped = true;
                try { serverSocket.close(); } catch (IOException ignored) {}
                if (executor != null) executor.shutdownNow();
            }

            private void handle(Socket socket) {
                try (Socket client = socket) {
                    client.setSoTimeout(15000);
                    BufferedReader reader = new BufferedReader(
                            new InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
                    String requestLine = reader.readLine();
                    if (requestLine == null || requestLine.isEmpty()) return;
                    String[] parts = requestLine.split(" ");
                    if (parts.length < 2) return;

                    Map<String, String> headers = new HashMap<>();
                    String line;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) {
                        int separator = line.indexOf(':');
                        if (separator > 0) {
                            headers.put(line.substring(0, separator).trim().toLowerCase(),
                                    line.substring(separator + 1).trim());
                        }
                    }

                    int contentLength = 0;
                    try { contentLength = Integer.parseInt(headers.getOrDefault("content-length", "0")); }
                    catch (NumberFormatException ignored) {}
                    if (contentLength < 0 || contentLength > MAX_BODY_BYTES) {
                        sendRaw(client, 413, "Request body too large");
                        return;
                    }
                    char[] bodyChars = new char[contentLength];
                    int read = 0;
                    while (read < contentLength) {
                        int count = reader.read(bodyChars, read, contentLength - read);
                        if (count < 0) break;
                        read += count;
                    }

                    String path = parts[1];
                    int queryIndex = path.indexOf('?');
                    if (queryIndex >= 0) path = path.substring(0, queryIndex);
                    HttpHandler handler = handlers.get(path);
                    if (handler == null) {
                        sendRaw(client, 404, "{\"ok\":false,\"error\":\"Not found\"}");
                        return;
                    }
                    handler.handle(new HttpExchange(client, parts[0], headers,
                            new String(bodyChars, 0, read)));
                } catch (Exception e) {
                    Log.e(TAG, "HTTP request failed: " + e.getMessage());
                }
            }

            private static void sendRaw(Socket socket, int status, String body) throws IOException {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                BufferedWriter writer = new BufferedWriter(
                        new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.US_ASCII));
                writer.write("HTTP/1.1 " + status + " " + (status == 404 ? "Not Found" : "Payload Too Large") + "\r\n");
                writer.write("Content-Type: application/json\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n");
                writer.flush();
                socket.getOutputStream().write(bytes);
                socket.getOutputStream().flush();
            }
        }

        private interface HttpHandler {
            void handle(HttpExchange exchange) throws IOException;
        }

        private static final class HttpExchange {
            private final Socket socket;
            private final String method;
            private final Map<String, String> requestHeaders;
            private final byte[] requestBody;
            private final Map<String, String> responseHeaders = new HashMap<>();
            private InputStream requestStream;
            private OutputStream responseStream;
            private boolean headersSent;

            HttpExchange(Socket socket, String method, Map<String, String> requestHeaders, String body) {
                this.socket = socket;
                this.method = method;
                this.requestHeaders = requestHeaders;
                this.requestBody = body.getBytes(StandardCharsets.UTF_8);
            }

            String getRequestMethod() { return method; }
            InputStream getRequestBody() {
                if (requestStream == null) requestStream = new java.io.ByteArrayInputStream(requestBody);
                return requestStream;
            }
            Map<String, String> getResponseHeaders() { return responseHeaders; }
            String getRequestHeader(String name) { return requestHeaders.get(name.toLowerCase()); }

            void sendResponseHeaders(int status, long length) throws IOException {
                if (headersSent) return;
                headersSent = true;
                responseStream = socket.getOutputStream();
                String reason = status == 200 ? "OK" : status == 204 ? "No Content" :
                        status == 405 ? "Method Not Allowed" : status == 504 ? "Gateway Timeout" : "Bad Request";
                StringBuilder header = new StringBuilder("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
                for (Map.Entry<String, String> entry : responseHeaders.entrySet()) {
                    header.append(entry.getKey()).append(": ").append(entry.getValue()).append("\r\n");
                }
                header.append("Content-Length: ").append(length).append("\r\nConnection: close\r\n\r\n");
                responseStream.write(header.toString().getBytes(StandardCharsets.US_ASCII));
                responseStream.flush();
            }

            OutputStream getResponseBody() { return responseStream; }
        }

    // ──────────────────────────────────────────────────────────────────────────
    //  Plugin methods (called from JavaScript)
    // ──────────────────────────────────────────────────────────────────────────

    private SharedPreferences cloudPrefs() {
        return getContext().getSharedPreferences(CLOUD_PREFS, android.content.Context.MODE_PRIVATE);
    }

    private SecretKey cloudKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(false)
                    .build());
            generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    private JSONObject readCloudCredentials() throws Exception {
        String encoded = cloudPrefs().getString(CLOUD_BLOB, null);
        if (encoded == null) return null;
        byte[] packed = Base64.decode(encoded, Base64.DEFAULT);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, cloudKey(), new GCMParameterSpec(128, java.util.Arrays.copyOf(packed, 12)));
        return new JSONObject(new String(cipher.doFinal(java.util.Arrays.copyOfRange(packed, 12, packed.length)), StandardCharsets.UTF_8));
    }

    private void writeCloudCredentials(String token, String phoneId) throws Exception {
        if (token == null || token.trim().isEmpty() || phoneId == null || phoneId.trim().isEmpty()) {
            throw new IllegalArgumentException("Access token and phone number ID are required.");
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, cloudKey());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(new JSONObject().put("accessToken", token.trim())
                .put("phoneNumberId", phoneId.trim()).toString().getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, packed, 0, iv.length);
        System.arraycopy(encrypted, 0, packed, iv.length, encrypted.length);
        cloudPrefs().edit().putString(CLOUD_BLOB, Base64.encodeToString(packed, Base64.NO_WRAP)).apply();
    }

    @PluginMethod
    public void getCloudApiStatus(PluginCall call) {
        try {
            JSONObject credentials = readCloudCredentials();
            JSObject result = new JSObject();
            result.put("supported", true);
            result.put("configured", credentials != null);
            if (credentials != null) result.put("phoneNumberId", credentials.optString("phoneNumberId"));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Unable to read Cloud API configuration", e);
        }
    }

    @PluginMethod
    public void configureCloudApi(PluginCall call) {
        try {
            writeCloudCredentials(call.getString("accessToken"), call.getString("phoneNumberId"));
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("configured", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void clearCloudApi(PluginCall call) {
        cloudPrefs().edit().remove(CLOUD_BLOB).apply();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("configured", false);
        call.resolve(result);
    }

    @PluginMethod
    public void sendCloudText(PluginCall call) {
        final String to = call.getString("to");
        final String body = call.getString("body");
        final String templateName = call.getString("templateName", "");
        final String templateLanguage = call.getString("templateLanguage", "en_US");
        if (to == null || body == null || to.trim().isEmpty() || body.trim().isEmpty()) {
            call.reject("Recipient and message are required.");
            return;
        }
        cloudExecutor.execute(() -> {
            try {
                JSONObject credentials = readCloudCredentials();
                if (credentials == null) throw new IllegalStateException("WhatsApp Cloud API is not configured on this host.");
                String phoneId = credentials.getString("phoneNumberId");
                URL url = new URL("https://graph.facebook.com/v23.0/" + phoneId + "/messages");
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(20000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + credentials.getString("accessToken"));
                connection.setRequestProperty("Content-Type", "application/json");
                String recipient = to.replaceAll("[^0-9]", "");
                if (recipient.length() == 10) recipient = "91" + recipient;
                JSONObject payload = new JSONObject().put("messaging_product", "whatsapp").put("to", recipient);
                if (templateName != null && !templateName.trim().isEmpty()) {
                    JSONArray params = new JSONArray();
                    JSONArray supplied = call.getArray("templateParams");
                    if (supplied != null) {
                        for (int i = 0; i < supplied.length(); i++) {
                            params.put(new JSONObject().put("type", "text").put("text", supplied.optString(i, "")));
                        }
                    } else {
                        params.put(new JSONObject().put("type", "text").put("text", body));
                    }
                    payload.put("type", "template").put("template", new JSONObject()
                            .put("name", templateName.trim())
                            .put("language", new JSONObject().put("code", templateLanguage))
                            .put("components", new JSONArray().put(new JSONObject()
                                    .put("type", "body").put("parameters", params))));
                } else {
                    payload.put("type", "text")
                            .put("text", new JSONObject().put("preview_url", false).put("body", body));
                }
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }
                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
                String response = "";
                if (stream != null) {
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    byte[] chunk = new byte[2048];
                    int count;
                    while ((count = stream.read(chunk)) != -1) buffer.write(chunk, 0, count);
                    response = buffer.toString(StandardCharsets.UTF_8.name());
                }
                if (status < 200 || status >= 300) throw new IOException("Cloud API HTTP " + status + ": " + response);
                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("response", response);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void createInvoicePdf(PluginCall call) {
        try {
            JSONObject bill = new JSONObject(call.getString("bill", "{}"));
            PdfDocument document = new PdfDocument();
            PdfDocument.PageInfo pageInfo = new PdfDocument.PageInfo.Builder(595, 842, 1).create();
            PdfDocument.Page page = document.startPage(pageInfo);
            Canvas canvas = page.getCanvas();
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(android.graphics.Color.BLACK);
            paint.setTextSize(14);
            float y = 40;
            String[] lines = {
                    firstNonEmpty(bill, "hotelName", "hotel_name", "Hotel"),
                    firstNonEmpty(bill, "hotelAddress", "hotel_address", ""),
                    firstNonEmpty(bill, "hotelPhone", "hotel_phone", ""),
                    "ROOM TAX INVOICE",
                    "Bill No: " + firstNonEmpty(bill, "bill_number", "billNumber", ""),
                    "Date: " + firstNonEmpty(bill, "created_at", "createdAt", ""),
                    "Guest: " + firstNonEmpty(bill, "customer_name", "customerName", ""),
                    ""
            };
            for (String line : lines) {
                if (!line.isEmpty()) { canvas.drawText(line, 36, y, paint); }
                y += 22;
            }
            JSONArray items = bill.optJSONArray("items");
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.optJSONObject(i);
                    if (item == null) continue;
                    String line = item.optString("name", "") + "  x" + item.optString("quantity", "1")
                            + "  " + item.optString("total", item.optString("price", "0"));
                    canvas.drawText(line, 36, y, paint);
                    y += 20;
                    if (y > 800) break;
                }
            }
            y += 12;
            canvas.drawText("Subtotal: " + firstNonEmpty(bill, "subtotal", "subTotal", "0"), 36, y, paint); y += 20;
            canvas.drawText("Tax: " + firstNonEmpty(bill, "tax_amount", "taxAmount", "0"), 36, y, paint); y += 20;
            canvas.drawText("Discount: " + bill.optString("discount", "0"), 36, y, paint); y += 20;
            paint.setFakeBoldText(true);
            canvas.drawText("TOTAL: " + firstNonEmpty(bill, "total", "grandTotal", "0"), 36, y, paint);
            document.finishPage(page);
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            document.writeTo(output);
            document.close();
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("pdfBase64", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
            result.put("fileName", "Invoice-" + bill.optString("bill_number", "Bill") + ".pdf");
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not generate invoice PDF: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void sendCloudPdf(PluginCall call) {
        final String to = call.getString("to");
        final String encodedPdf = call.getString("pdfBase64");
        final String fileName = call.getString("fileName", "Invoice.pdf");
        final String caption = call.getString("caption", "");
        if (to == null || encodedPdf == null) {
            call.reject("Recipient and PDF are required.");
            return;
        }
        cloudExecutor.execute(() -> {
            try {
                JSONObject credentials = readCloudCredentials();
                if (credentials == null) throw new IllegalStateException("WhatsApp Cloud API is not configured on this host.");
                String phoneId = credentials.getString("phoneNumberId");
                byte[] pdf = Base64.decode(encodedPdf, Base64.DEFAULT);
                String boundary = "----BillNest" + System.currentTimeMillis();
                URL mediaUrl = new URL("https://graph.facebook.com/v23.0/" + phoneId + "/media");
                HttpURLConnection upload = (HttpURLConnection) mediaUrl.openConnection();
                upload.setRequestMethod("POST");
                upload.setConnectTimeout(15000);
                upload.setReadTimeout(20000);
                upload.setDoOutput(true);
                upload.setRequestProperty("Authorization", "Bearer " + credentials.getString("accessToken"));
                upload.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                try (OutputStream out = upload.getOutputStream()) {
                    out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"messaging_product\"\r\n\r\nwhatsapp\r\n").getBytes(StandardCharsets.UTF_8));
                    out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\napplication/pdf\r\n").getBytes(StandardCharsets.UTF_8));
                    out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName.replace("\"", "") + "\"\r\nContent-Type: application/pdf\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    out.write(pdf);
                    out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                }
                int uploadStatus = upload.getResponseCode();
                InputStream uploadStream = uploadStatus >= 200 && uploadStatus < 300 ? upload.getInputStream() : upload.getErrorStream();
                String uploadBody = readStream(uploadStream);
                if (uploadStatus < 200 || uploadStatus >= 300) throw new IOException("Cloud media upload failed (" + uploadStatus + "): " + uploadBody);
                String mediaId = new JSONObject(uploadBody).getString("id");
                URL messageUrl = new URL("https://graph.facebook.com/v23.0/" + phoneId + "/messages");
                HttpURLConnection message = (HttpURLConnection) messageUrl.openConnection();
                message.setRequestMethod("POST");
                message.setConnectTimeout(15000);
                message.setReadTimeout(20000);
                message.setDoOutput(true);
                message.setRequestProperty("Authorization", "Bearer " + credentials.getString("accessToken"));
                message.setRequestProperty("Content-Type", "application/json");
                String recipient = to.replaceAll("[^0-9]", "");
                if (recipient.length() == 10) recipient = "91" + recipient;
                JSONObject payload = new JSONObject().put("messaging_product", "whatsapp").put("to", recipient)
                        .put("type", "document").put("document", new JSONObject().put("id", mediaId)
                                .put("caption", caption).put("filename", fileName));
                try (OutputStream out = message.getOutputStream()) { out.write(payload.toString().getBytes(StandardCharsets.UTF_8)); }
                int messageStatus = message.getResponseCode();
                String messageBody = readStream(messageStatus >= 200 && messageStatus < 300 ? message.getInputStream() : message.getErrorStream());
                if (messageStatus < 200 || messageStatus >= 300) throw new IOException("Cloud document send failed (" + messageStatus + "): " + messageBody);
                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("response", messageBody);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void shareViaWhatsApp(PluginCall call) {
        final String text = call.getString("text");
        final String phoneNumber = call.getString("phoneNumber");
        if (text == null || text.isEmpty()) {
            call.reject("Message text is required.");
            return;
        }
        try {
            final String fileBase64 = call.getString("fileBase64");
            if (fileBase64 != null && !fileBase64.isEmpty()) {
                String mimeType = call.getString("mimeType");
                if (mimeType == null || mimeType.isEmpty()) mimeType = "application/pdf";
                if (!"application/pdf".equals(mimeType)) {
                    call.reject("Only PDF bills can be shared from this screen.");
                    return;
                }
                byte[] fileBytes = Base64.decode(fileBase64, Base64.DEFAULT);
                if (fileBytes.length == 0 || fileBytes.length > 20 * 1024 * 1024) {
                    call.reject("The bill PDF is empty or too large to share.");
                    return;
                }
                String fileName = call.getString("fileName");
                if (fileName == null || fileName.isEmpty()) fileName = "Bill.pdf";
                fileName = fileName.replaceAll("[^A-Za-z0-9._-]", "_");
                if (!fileName.toLowerCase().endsWith(".pdf")) fileName += ".pdf";
                File shareDirectory = new File(getContext().getCacheDir(), "shared-bills");
                if (!shareDirectory.exists() && !shareDirectory.mkdirs()) {
                    throw new IOException("Could not prepare the bill for sharing.");
                }
                File sharedBill = new File(shareDirectory, fileName);
                try (FileOutputStream output = new FileOutputStream(sharedBill)) {
                    output.write(fileBytes);
                }
                Uri billUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        sharedBill
                );
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType(mimeType);
                intent.putExtra(Intent.EXTRA_STREAM, billUri);
                intent.putExtra(Intent.EXTRA_TEXT, text);
                intent.setClipData(ClipData.newUri(getContext().getContentResolver(), fileName, billUri));
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.setPackage("com.whatsapp");
                String recipient = phoneNumber == null ? "" : phoneNumber.replaceAll("[^0-9]", "");
                if (recipient.length() == 10) {
                    recipient = "91" + recipient;
                } else if (recipient.length() == 11 && recipient.startsWith("0")) {
                    recipient = "91" + recipient.substring(1);
                }
                if (!recipient.isEmpty()) {
                    intent.putExtra("jid", recipient + "@s.whatsapp.net");
                }
                try {
                    getContext().startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    intent.setPackage(null);
                    getContext().startActivity(Intent.createChooser(intent, "Send bill"));
                }
                call.resolve();
                return;
            }
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("text/plain");
            intent.putExtra(Intent.EXTRA_TEXT, text);
            String recipient = phoneNumber == null ? "" : phoneNumber.replaceAll("[^0-9]", "");
            if (recipient.length() == 10) {
                recipient = "91" + recipient;
            } else if (recipient.length() == 11 && recipient.startsWith("0")) {
                recipient = "91" + recipient.substring(1);
            }
            if (!recipient.isEmpty()) intent.putExtra("jid", recipient + "@s.whatsapp.net");
            intent.setPackage("com.whatsapp");
            try {
                getContext().startActivity(intent);
            } catch (ActivityNotFoundException e) {
                intent.setPackage(null);
                getContext().startActivity(Intent.createChooser(intent, "Send message"));
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open WhatsApp: " + e.getMessage(), e);
        }
    }

    private static String readStream(InputStream stream) throws IOException {
        if (stream == null) return "";
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[2048];
        int count;
        while ((count = stream.read(buffer)) != -1) output.write(buffer, 0, count);
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private static String firstNonEmpty(JSONObject object, String primary, String alternate, String fallback) {
        String value = object.optString(primary, "");
        if (value == null || value.isEmpty()) value = object.optString(alternate, "");
        return value == null || value.isEmpty() ? fallback : value;
    }

    @PluginMethod
    public void start(PluginCall call) {
        int port = call.getInt("port", DEFAULT_PORT);
        authToken = call.getString("authToken", "");

        if (running.get()) {
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("alreadyRunning", true);
            result.put("ip", getLocalIp());
            result.put("port", port);
            call.resolve(result);
            return;
        }

        try {
            httpServer = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
            httpServer.createContext("/health", new HealthHandler());
            httpServer.createContext("/rpc", new RpcHandler());
            httpServer.createContext("/", new NotFoundHandler());
            httpServer.setExecutor(Executors.newCachedThreadPool());
            httpServer.start();
            running.set(true);

            Log.i(TAG, "BillNest host server started on port " + port + " ip=" + getLocalIp());

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("alreadyRunning", false);
            result.put("ip", getLocalIp());
            result.put("port", port);
            call.resolve(result);
        } catch (IOException e) {
            Log.e(TAG, "Failed to start server: " + e.getMessage());
            call.reject("Failed to start server: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (httpServer != null) {
            httpServer.stop(0);
            httpServer = null;
        }
        running.set(false);
        pendingRpcs.clear();

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", running.get());
        result.put("ip", running.get() ? getLocalIp() : "");
        call.resolve(result);
    }

    @PluginMethod
    public void getLocalIp(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ip", getLocalIp());
        call.resolve(result);
    }

    /**
     * Called from JavaScript after it has computed the result for an RPC request.
     * Unblocks the waiting HTTP response thread.
     */
    @PluginMethod
    public void rpcRespond(PluginCall call) {
        String requestId = call.getString("requestId");
        String body = call.getString("body");
        int status = call.getInt("status", 200);

        if (requestId == null || !pendingRpcs.containsKey(requestId)) {
            call.reject("Unknown requestId");
            return;
        }

        PendingRpc pending = pendingRpcs.remove(requestId);
        if (pending != null) {
            synchronized (pending.lock) {
                pending.responseBody = body != null ? body : "{\"ok\":false,\"error\":\"no body\"}";
                pending.statusCode = status;
                pending.done = true;
                pending.lock.notifyAll();
            }
        }

        call.resolve();
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  HTTP handlers
    // ──────────────────────────────────────────────────────────────────────────

    private class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            addCorsHeaders(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendResponse(exchange, 204, "{}");
                return;
            }
            if (!isAuthorized(exchange)) {
                sendResponse(exchange, 401, "{\"ok\":false,\"error\":\"Authentication required.\"}");
                return;
            }
            // Ask JS for hotel name + feature flags via a lightweight rpc
            // For health, use a synchronous-style call with short timeout
            String requestId = java.util.UUID.randomUUID().toString();
            PendingRpc pending = new PendingRpc(exchange);
            pendingRpcs.put(requestId, pending);

            JSObject event = new JSObject();
            event.put("requestId", requestId);
            event.put("type", "health");
            notifyListeners("rpcRequest", event);

            // Wait up to 3 seconds for JS to respond
            synchronized (pending.lock) {
                if (!pending.done) {
                    try { pending.lock.wait(3000); } catch (InterruptedException ignored) {}
                }
            }
            pendingRpcs.remove(requestId);

            if (pending.done && pending.responseBody != null) {
                sendResponse(exchange, 200, pending.responseBody);
            } else {
                // Fallback if JS didn't respond in time
                sendResponse(exchange, 200, "{\"ok\":true,\"hotelName\":\"\",\"captainEnabled\":false,\"tableManagementEnabled\":false,\"version\":1}");
            }
        }
    }

    private class RpcHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            addCorsHeaders(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendResponse(exchange, 204, "{}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendResponse(exchange, 405, "{\"ok\":false,\"error\":\"Method not allowed\"}");
                return;
            }
            if (!isAuthorized(exchange)) {
                sendResponse(exchange, 401, "{\"ok\":false,\"error\":\"Authentication required.\"}");
                return;
            }

            // Read body (cap at 5 MB)
            String body;
            try {
                InputStream is = exchange.getRequestBody();
                byte[] buffer = new byte[MAX_BODY_BYTES];
                int totalRead = 0, n;
                while (totalRead < MAX_BODY_BYTES && (n = is.read(buffer, totalRead, MAX_BODY_BYTES - totalRead)) != -1) {
                    totalRead += n;
                }
                body = new String(buffer, 0, totalRead, StandardCharsets.UTF_8);
            } catch (Exception e) {
                sendResponse(exchange, 400, "{\"ok\":false,\"error\":\"Could not read request body\"}");
                return;
            }
            try {
                String channel = new JSONObject(body).optString("channel", "");
                if (isLocalOnlyChannel(channel)) {
                    sendResponse(exchange, 403, "{\"ok\":false,\"error\":\"This operation is only available on the Host device.\"}");
                    return;
                }
            } catch (Exception e) {
                sendResponse(exchange, 400, "{\"ok\":false,\"error\":\"Invalid request.\"}");
                return;
            }

            String requestId = java.util.UUID.randomUUID().toString();
            PendingRpc pending = new PendingRpc(exchange);
            pendingRpcs.put(requestId, pending);

            // Fire event to JavaScript
            JSObject event = new JSObject();
            event.put("requestId", requestId);
            event.put("type", "rpc");
            event.put("body", body);
            notifyListeners("rpcRequest", event);

            // Block this thread until JS calls rpcRespond() or timeout (10s)
            synchronized (pending.lock) {
                if (!pending.done) {
                    try { pending.lock.wait(10000); } catch (InterruptedException ignored) {}
                }
            }
            pendingRpcs.remove(requestId);

            if (pending.done && pending.responseBody != null) {
                sendResponse(exchange, pending.statusCode, pending.responseBody);
            } else {
                sendResponse(exchange, 504, "{\"ok\":false,\"error\":\"Handler timed out\"}");
            }
        }
    }

    private static class NotFoundHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            addCorsHeaders(exchange);
            sendResponse(exchange, 404, "{\"ok\":false,\"error\":\"Not found\"}");
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Helpers
    // ──────────────────────────────────────────────────────────────────────────

    private static void addCorsHeaders(HttpExchange exchange) {
        exchange.getResponseHeaders().put("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.getResponseHeaders().put("Access-Control-Allow-Headers", "Content-Type, X-BillNest-Token");
        exchange.getResponseHeaders().put("Content-Type", "application/json");
    }

    private boolean isAuthorized(HttpExchange exchange) {
        String supplied = exchange.getRequestHeader("x-billnest-token");
        if (authToken == null || authToken.isEmpty() || supplied == null) return false;
        return MessageDigest.isEqual(
                supplied.getBytes(StandardCharsets.UTF_8),
                authToken.getBytes(StandardCharsets.UTF_8));
    }

    private static boolean isLocalOnlyChannel(String channel) {
        return channel.equals("backup:chooseFolder") || channel.equals("backup:now")
                || channel.equals("backup:openFolder") || channel.equals("backup:restore")
                || channel.equals("data:exportForMobile") || channel.equals("room:pickIdDocument")
                || channel.equals("bill:openRecordsFolder")
                || channel.equals("kot:openRecordsFolder") || channel.startsWith("sync:");
    }

    private static void sendResponse(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().put("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    /**
     * Picks the best local IPv4 address for the WiFi/LAN interface,
     * mirroring the logic in electron/lanServer.cjs getLocalIp().
     */
    static String getLocalIp() {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) return "127.0.0.1";
            String best = null;
            int bestScore = Integer.MAX_VALUE;

            for (NetworkInterface iface : Collections.list(ifaces)) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                String name = iface.getName().toLowerCase();

                for (java.net.InetAddress addr : Collections.list(iface.getInetAddresses())) {
                    if (addr.isLoopbackAddress()) continue;
                    if (!(addr instanceof java.net.Inet4Address)) continue;
                    String ip = addr.getHostAddress();
                    if (ip.startsWith("169.254.")) continue; // APIPA

                    int score = 0;
                    // Virtual/VPN adapters — heavily deprioritize
                    if (name.contains("dummy") || name.contains("rmnet") || name.contains("p2p")) score += 50;
                    // WiFi (wlan) is the best candidate on Android
                    if (name.startsWith("wlan")) score -= 10;
                    // Private ranges preferred
                    if (!ip.startsWith("10.") && !ip.startsWith("192.168.") && !ip.matches("172\\.(1[6-9]|2\\d|3[01])\\..*")) score += 10;

                    if (score < bestScore) {
                        bestScore = score;
                        best = ip;
                    }
                }
            }
            return best != null ? best : "127.0.0.1";
        } catch (Exception e) {
            return "127.0.0.1";
        }
    }
}
