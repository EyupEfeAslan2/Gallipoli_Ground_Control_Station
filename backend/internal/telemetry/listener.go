package telemetry

import (
	"bufio"
	"encoding/json"
	"log"
	"strings"

	"go.bug.st/serial"
)

type TelemetryPacket struct {
	Time     float64 `json:"time"`
	Thrust   float64 `json:"thrust"`
	Pressure float64 `json:"pressure"`
	State    string  `json:"state"`
}

// StartSerialListener, portu açar ve arka planda (goroutine) sonsuz bir dinleme döngüsü başlatır.
// Gelen her temiz paketi WebSocket'e iletilmek üzere dataChannel kanalına fırlatır.
func StartSerialListener(portName string, baudRate int, dataChannel chan<- TelemetryPacket) {
	mode := &serial.Mode{
		BaudRate: baudRate,
	}

	// Portu açıyoruz
	port, err := serial.Open(portName, mode)
	if err != nil {
		log.Printf("Uyarı: Seri port açılamadı (%s): %v. Sisteme donanım bağlı değil, veri okuması yapılmayacak.\n", portName, err)
		return
	}

	log.Printf("Telemetri Aktif: %s portu %d baud hızında dinleniyor...\n", portName, baudRate)

	// Ana akışı bloklamamak için dinleme işini Goroutine'e devrediyoruz
	go func() {
		// Fonksiyon bittiğinde portun kapanmasını garantiliyoruz
		defer port.Close()

		reader := bufio.NewReader(port)

		for {
			// Satır sonuna ('\n') kadar oku
			line, err := reader.ReadString('\n')
			if err != nil {
				log.Println("Uyarı: Port okuma hatası veya kablo koptu:", err)
				break
			}

			// Gelen satırın başındaki/sonundaki boşlukları ve enter karakterlerini temizle
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}

			// Cuma Ali'den gelen stringi JSON Struct'ına dönüştür (Unmarshal)
			var packet TelemetryPacket
			err = json.Unmarshal([]byte(line), &packet)
			if err != nil {
				// Cihaz ilk açıldığında yarım paket gelebilir, sistemi çökertmeyip es geçiyoruz
				log.Printf("JSON Parse Hatası (Bozuk Paket): %s | Hata: %v\n", line, err)
				continue
			}

			// Parse edilen tertemiz veriyi, ana sunucudaki WebSocket'e basmak üzere kanala gönder
			dataChannel <- packet
		}
	}()
}
