package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"ground_control_station/internal/telemetry"
)

// ─── Websocket Commands ────────────────────────────────────────────────────────
type Command struct {
	Type string `json:"type"`
}



// ─── Veri Anlaşması (Data Contract) ─────────────────────────────────────────
// Tüm kanallar için tek bir telemetri paketi.
// Frontend ile backend arasındaki sözleşme; hiçbir alan sessizce değiştirilmez.
type Telemetry struct {
	// Meta
	Timestamp int64   `json:"timestamp"`
	State     string  `json:"state"`
	Elapsed   float64 `json:"elapsed_s"`

	// Kontrol
	ValveOpen bool `json:"valve_open"`

	// ── Thrust ──────────────────────────────────────────────────────────────
	ThrustN      float64 `json:"thrust_n"`
	ThrustTarget float64 `json:"thrust_target_n"`

	// ── Kütlesel Debi (mdot) ────────────────────────────────────────────────
	MdotOx       float64 `json:"mdot_ox"`
	MdotInj      float64 `json:"mdot_inj"`
	MdotVnt      float64 `json:"mdot_vnt"`
	MdotGrn      float64 `json:"mdot_grn"`
	MdotNoz      float64 `json:"mdot_noz"`
	MdotCmbr     float64 `json:"mdot_cmbr"`
	MdotOxTarget float64 `json:"mdot_ox_target"`

	// ── Basınç (Pa cinsinden iletilir, frontend dönüştürür) ─────────────────
	PressureChamberPa float64 `json:"pressure_chamber_pa"`
	PressureTankPa    float64 `json:"pressure_tank_pa"`
	PressureNozExitPa float64 `json:"pressure_noz_exit_pa"`

	// ── Sıcaklık ────────────────────────────────────────────────────────────
	TempTankK    float64 `json:"temp_tank_k"`
	TempChamberK float64 `json:"temp_chamber_k"`

	// ── Kütle (kg) ──────────────────────────────────────────────────────────
	MassOxLiq      float64 `json:"mass_ox_liq_kg"`
	MassOxVap      float64 `json:"mass_ox_vap_kg"`
	MassCmbrStored float64 `json:"mass_cmbr_stored_kg"`
	MassGrain      float64 `json:"mass_grain_kg"`

	// ── Grain Geometrisi ────────────────────────────────────────────────────
	GrainThickness float64 `json:"grain_thickness_m"`
	NetRegression  float64 `json:"net_regression_m"`

	// ── Nozzle / Performans ─────────────────────────────────────────────────
	MachExit    float64 `json:"mach_exit"`
	Cstar       float64 `json:"cstar_m_s"`
	ChamberTemp float64 `json:"chamber_temp_k"`

	// ── Yanma Odası Hacmi ───────────────────────────────────────────────────
	EmptyChamberVolume float64 `json:"empty_chamber_vol_m3"`
}



// ─── WebSocket Hub ────────────────────────────────────────────────────────────
// Tek goroutine veri üretir; N tane bağlı client'a broadcast edilir.

type Hub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]bool
}

func newHub() *Hub { return &Hub{clients: make(map[*websocket.Conn]bool)} }

func (h *Hub) register(c *websocket.Conn) {
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()
}

func (h *Hub) unregister(c *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

func (h *Hub) broadcast(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
			log.Printf("Yazma hatası, bağlantı kapatılıyor: %v", err)
			c.Close()
		}
	}
}

// ─── HTTP Handlers ────────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func handleConnections(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("WebSocket yükseltme hatası:", err)
			return
		}
		hub.register(ws)
		log.Printf("Yeni bağlantı: %s | Aktif: hub", r.RemoteAddr)

		// Client koptuğunda temizle / Mesaj dinle
		go func() {
			for {
				var cmd Command
				err := ws.ReadJSON(&cmd)
				if err != nil {
					hub.unregister(ws)
					ws.Close()
					return
				}
				if cmd.Type == "START" {
					log.Println("Frontend'den START komutu geldi.")
				} else if cmd.Type == "ABORT" {
					log.Println("Frontend'den ABORT komutu geldi.")
				}
			}
		}()
	}
}

// ─── Ana Döngü ────────────────────────────────────────────────────────────────

func main() {
	portName := flag.String("port", "/dev/ttyUSB0", "Seri port adı (örn: COM3, /dev/ttyUSB0)")
	baudRate := flag.Int("baud", 115200, "Baud rate")
	flag.Parse()

	hub := newHub()

	http.HandleFunc("/ws", handleConnections(hub))
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// CORS preflight
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
	})

	// Seri porttan gelen verileri dinlemek için kanal
	telemetryChan := make(chan telemetry.TelemetryPacket, 100)

	// Arka planda seri portu dinle
	telemetry.StartSerialListener(*portName, *baudRate, telemetryChan)

	// Veri üretici goroutine — artık seri portu dinliyor
	go func() {
		log.Println("Telemetri verisi bekleniyor...")

		for packet := range telemetryChan {
			// Frontend'in beklediği Telemetry modeline mapleme yapıyoruz.
			// Geri kalan alanlar şimdilik struct varsayılanı (0) olacak.
			t := Telemetry{
				Timestamp:         time.Now().UnixMilli(),
				State:             packet.State,
				Elapsed:           packet.Time,
				ThrustN:           packet.Thrust,
				PressureChamberPa: packet.Pressure,
			}

			payload, err := json.Marshal(t)
			if err != nil {
				log.Println("JSON hata:", err)
				continue
			}
			hub.broadcast(payload)
		}
	}()

	log.Println("────────────────────────────────────────")
	log.Println("  GALLIPOLI Telemetri Sunucusu Başladı")
	log.Println("  WebSocket : ws://localhost:8080/ws")
	log.Println("  Health    : http://localhost:8080/health")
	log.Println("────────────────────────────────────────")

	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal("Sunucu dinlenemiyor!:", err)
	}
}
