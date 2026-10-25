// Exported by opendesigner (opendesigner export): screen "Screen" (route /screen) of document "Test" (doc). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
import SwiftUI

struct Screen: View {
    var body: some View {
        // Screen (data-node-id="scr")
        ZStack(alignment: .topLeading) {
            // Grid (data-node-id="g")
            ZStack(alignment: .topLeading) {
                // a (data-node-id="a")
                Rectangle().fill(Color(red: 255/255, green: 0/255, blue: 0/255))
                    .frame(width: 20, height: 20, alignment: .topLeading)
                    .offset(x: 0, y: 0)
                // b (data-node-id="b")
                Rectangle().fill(Color(red: 0/255, green: 255/255, blue: 0/255))
                    .frame(width: 20, height: 20, alignment: .topLeading)
                    .offset(x: 88, y: 0)
                // c (data-node-id="c")
                Rectangle().fill(Color(red: 0/255, green: 0/255, blue: 255/255))
                    .frame(height: 20, alignment: .topLeading)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .frame(width: 20, alignment: .topLeading)
                    .offset(x: 0, y: 44)
            }
            .frame(width: 300, height: 120, alignment: .topLeading)
            .background(Rectangle().fill(Color(red: 229/255, green: 229/255, blue: 229/255)))
        }
        .frame(width: 400, height: 300, alignment: .topLeading)
        .background(Rectangle().fill(Color(red: 255/255, green: 255/255, blue: 255/255)))
    }
}

#Preview {
    Screen()
}
