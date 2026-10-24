// Exported by opendesigner (opendesigner export): screen "Screen" (route /screen) of document "Test" (doc). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
import SwiftUI

struct Screen: View {
    var body: some View {
        // Screen (data-node-id="scr")
        ZStack(alignment: .topLeading) {
            // Card (data-node-id="card")
            VStack(alignment: .leading, spacing: 8) {
                // Title (data-node-id="title")
                Text("Hello world")
                    .font(.custom("Inter", size: 20).weight(.bold))
                    .foregroundColor(Color(red: 255/255, green: 255/255, blue: 255/255))
                    .frame(width: 200, height: 19, alignment: .topLeading)
                // Dot (data-node-id="dot")
                Ellipse().fill(Color(red: 229/255, green: 229/255, blue: 229/255))
                    .frame(width: 24, height: 24, alignment: .topLeading)
            }
            .padding(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
            .frame(width: 300, height: 120, alignment: .leading)
            .background(Rectangle().fill(LinearGradient(stops: [Gradient.Stop(color: Color(red: 229/255, green: 77/255, blue: 77/255), location: 0), Gradient.Stop(color: Color(red: 51/255, green: 102/255, blue: 229/255), location: 1)], startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))))
            .clipShape(Rectangle())
            .shadow(color: Color(red: 0/255, green: 0/255, blue: 0/255), radius: 4, x: 0, y: 4)
            .offset(x: 20, y: 20)
            // Free (data-node-id="free")
            RoundedRectangle(cornerRadius: 12).fill(Color(red: 229/255, green: 77/255, blue: 77/255))
                .frame(width: 100, height: 50, alignment: .topLeading)
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(red: 51/255, green: 102/255, blue: 229/255), lineWidth: 2))
                .offset(x: 40, y: 180)
        }
        .frame(width: 400, height: 300, alignment: .topLeading)
        .background(Rectangle().fill(Color(red: 255/255, green: 255/255, blue: 255/255)))
    }
}

#Preview {
    Screen()
}
