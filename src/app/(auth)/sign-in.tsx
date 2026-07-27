import { TextInput, View } from "react-native";

export default function SignInScreen() {
  return (
    <View>
      <TextInput placeholder="email" />
      <TextInput placeholder="password" secureTextEntry />
    </View>
  );
}
